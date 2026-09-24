# Peers — Cross-egirl Agent-to-Agent Protocol

How two egirl instances talk to each other for agent-to-agent work: the `egirl-peer/1` protocol, its wire format, and how to configure it.

## Mental Model

A peer is *a tool, not a channel*. The local LLM stays the operator; when it wants another egirl's help — checking something on that machine, sharing findings, splitting work — it calls `peer_message`, the same way it calls `code_agent` or `execute_command`. On the receiving side the message arrives through the existing HTTP API, which is egirl's one extensibility boundary.

```
┌──────────── kira ────────────┐          ┌──────────── luna ────────────┐
│  agent loop                  │          │  HTTP API (Bun.serve)        │
│    └─ peer_message tool ─────┼─ POST ──▶│    └─ POST /peer/message     │
│         (waits for reply)    │          │         └─ agent loop runs   │
│                              │◀─ JSON ──┼─            final reply      │
└──────────────────────────────┘          └──────────────────────────────┘
```

There is no capability negotiation and no message broker inside egirl. Peers are declared in `egirl.toml` or resolved from a Wald registry ([Discovery](#discovery)), authentication is the API's existing bearer token, and `peer_message` is a synchronous HTTP request/reply. When the other side is not up, or is not an egirl, work goes through the Wald mailbox instead ([Mailbox delegation](#mailbox-delegation)).

## Wire Format

The protocol identifier is `egirl-peer/1`. Two endpoints on the existing HTTP API (`src/api.ts`):

### `GET /peer/identity`

The ping/handshake. Returns who is answering:

```json
{ "service": "egirl", "protocol": "egirl-peer/1", "name": "luna" }
```

### `POST /peer/message`

Send a message to this instance's agent and wait for the reply.

Request:

```json
{
  "protocol": "egirl-peer/1",
  "from": "kira",
  "message": "Is the staging deploy green on your box?"
}
```

- `from` — name the sending agent goes by (its instance name). Required.
- `message` — the message text. Required.
- `protocol` — optional on the wire so a v1 receiver can read future senders. A present-but-foreign value (not `egirl-peer/*`) is rejected with 400.

Response:

```json
{
  "protocol": "egirl-peer/1",
  "from": "luna",
  "content": "Checked — deploy is green, last run 14:02.",
  "session_id": "peer:kira",
  "turns": 3
}
```

The receiver runs the message through its full agent loop (tools, memory, the lot) and `content` is the loop's final reply. Expect replies to take a while — the peer may be driving tools or its code agent. Errors use the API's normal shape: `{ "error": "..." }` with a 4xx/5xx status.

### Authentication

Reuses the HTTP API's bearer token. If the receiving instance sets `EGIRL_API_TOKEN`, peer requests must send `Authorization: Bearer <that token>` — the sender configures it per peer via `.env` (below). No separate peer credential system.

### Sessions

Each peer gets one persistent conversation on the receiving side, keyed `peer:<name>` (name sanitized to `[a-z0-9_-]`). Repeated messages from the same peer continue the same conversation, and it survives restarts when conversation persistence is enabled — the same treatment a human on XMPP gets.

### Inbound framing

The receiver does not hand the raw message to its model. It wraps it so the model knows it is in an agent-to-agent exchange:

```
[agent-to-agent] Message from peer "kira", another egirl agent. Your reply text is
returned to it directly — do not call peer_message to answer this (only to involve
a different peer). Be direct and information-dense; skip pleasantries.

<message>
```

That framing is the loop guard: replies travel back in the HTTP response, so neither side needs to call `peer_message` to answer, and two instances don't ping-pong calls at each other. The agent loop's `maxTurns` bounds any run regardless.

## Configuration

Declare peers in `egirl.toml`:

```toml
[[peers]]
name = "luna"
url = "http://192.168.1.20:3000"
timeout_ms = 120000               # optional, default 120000
```

Tokens live in `.env`, following the existing secrets convention. For a peer named `luna`, set:

```
EGIRL_PEER_LUNA_TOKEN=<luna's EGIRL_API_TOKEN>
```

(Non-alphanumeric characters in the name become `_` in the variable name.)

The receiving instance just needs its API running (`bun run start api` with `[channels.api]` configured). The sending instance identifies itself by its instance name (`--instance`, see the multi-instance layout in `egirl.example.toml`), falling back to `egirl`.

The tools register whenever at least one peer is configured; set `peers = false` under `[tools]` to turn them off without deleting the config.

### Discovery

Declaring peers statically means every instance carries an entry for every other instance: N instances, N-1 entries each, and adding one means editing N configs. A [Wald](https://github.com/Schneewolf-Labs/Wald) agent registry inverts that — each instance announces itself once and asks who else is there.

```toml
[[mcp.servers]]
name = "wald"
url = "http://wald.internal:8091/mcp"
headers = { Authorization = "Bearer $WALD_TOKEN" }

[peer_discovery]
enabled = true
registry = "wald"                        # the [[mcp.servers]] name, default "wald"
self_url = "http://192.168.1.10:3000"    # so others can reach this instance
capabilities = ["coding", "vision"]      # optional, advertised to the registry
```

On startup the instance registers itself with `protocol = "egirl-peer/1"`, then adds any registry peers the config did not already name. A peer that moves, or a new instance appearing, needs no config edit anywhere.

Three things worth knowing:

**Discovery covers addresses, not credentials.** Wald deliberately stores a *reference* to where a secret lives rather than the secret, so it can tell you a peer exists at a URL and cannot hand you the token to talk to it. Tokens still come from `EGIRL_PEER_<NAME>_TOKEN`, exactly as for static peers.

**Configuration wins on a collision.** A peer pinned by hand in `[[peers]]` is never overridden by the registry — someone pinned that URL for a reason, and a registry silently winning is a confusing way to find out it changed.

**A registry that is down is not fatal.** Static peers keep working, discovery contributes nothing, and the agent starts. An optional source of addresses should never be able to stop an agent from running.

Only agents registered with `protocol = "egirl-peer/1"` are treated as peers, so a hub shared with unrelated MCP agents does not pollute the peer list. Agents with no published `endpoint_url`, or whose status is not `active`, are skipped.

## Tools

### `peer_message`

Send a message to a named peer and wait for its reply.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `peer` | string | Yes | Name of a configured peer (case-insensitive) |
| `message` | string | Yes | The message — self-contained, since the peer doesn't share conversation context |
| `timeout_ms` | number | No | Max wait for the reply (default: the peer's `timeout_ms`) |

A timeout is not a failure of the peer's run — its side keeps the conversation, so the model can ask again later.

### `peer_list`

No parameters. Lists configured peers and pings each one's `/peer/identity` to report reachability:

```
luna — http://192.168.1.20:3000 — online as "luna" (egirl-peer/1)
nyx — http://192.168.1.30:3000 — unreachable
```

## Mailbox delegation

`peer_message` needs both instances up at once and only reaches egirls. The [Wald](https://github.com/Schneewolf-Labs/Wald) A2A mailbox covers the rest: work is left for an agent that is asleep, or that isn't egirl at all, and picked up when it next looks.

```
┌──────────── kira ────────────┐        ┌─── Wald ───┐        ┌──────────── luna ────────────┐
│ task run                     │        │            │        │ mailbox task (cron)          │
│  └─ delegate ────────────────┼─send──▶│  inbox of  │◀─read──┼─ read_inbox                  │
│     (task parks: awaiting)   │        │   luna     │        │   └─ record as a task, ack   │
│                              │        │            │        │ task run                     │
│ mailbox task (cron)          │        │  inbox of  │◀─send──┼─ result, same thread         │
│  └─ read_inbox ──────────────┼─read──▶│   kira     │        │                              │
│     └─ append to task, resume│        └────────────┘        └──────────────────────────────┘
└──────────────────────────────┘
```

Wald stays a tool reached over MCP (`send_agent_message`, `read_inbox`, `ack_messages`). egirl adds no queue, no retry layer and no listener: Wald's inbox is at-least-once, and inbound is polled by a seeded task on the ordinary task runner.

### Configuration

```toml
[[mcp.servers]]
name = "wald"
url = "http://wald.internal:8091/mcp"
headers = { Authorization = "Bearer $WALD_TOKEN" }

[mailbox]
enabled = true
registry = "wald"          # the [[mcp.servers]] name, default "wald"
schedule = "*/5 * * * *"   # how often the mailbox task polls
```

The instance registers itself with Wald at startup under its instance name (or `[peer_discovery] self_name`), with no address if it has no `self_url`. The mailbox needs conversation persistence (every message is recorded before it is acked) and the task runner (which polls); without them it stays off.

### `delegate`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent` | string | Yes | The recipient's Wald slug: any registered agent, not only egirl peers |
| `message` | string | Yes | The work, self-contained |

The delegation is recorded (thread → calling session, recipient, request) *before* it is sent, on a thread id egirl picks, so no answer can arrive for a thread it has no record of.

- **From a task**, the run parks as `awaiting`, the same state an unanswered `report` ask leaves. When the answer arrives it is appended to the task's conversation along with the original request, and the task resumes through the same path a `/chat` reply takes. A task that didn't persist its conversation is switched to persisting, or the next run would never see the answer.
- **From a conversation**, the run carries on. A live chat keeps its transcript in memory, so the answer is recorded on `mail:<agent>` and passed to the principal rather than written behind the session.

### What the inbox poll does

The seeded `mailbox` task runs on its cron schedule. It never calls the model itself. Each unread message becomes exactly one durable record, and **only then is it acked**:

| Message | Record |
|---|---|
| Answer on a thread this instance delegated, from the agent it delegated to | appended to the waiting task, which resumes (see above) |
| `request` from a trusted sender | a oneshot task; its final reply goes back on the same thread as `role=response` |
| Anything else from a trusted sender (a `notify`, a `response` on a thread with no record) | appended to `mail:<sender>`, principal told |
| Everything else | appended to `mail:untrusted`, principal told through `report` notify, **never acted on** |

A crash between the record and the ack leaves the message unread in Wald, so the next poll sees it again. A `seen` table (`mailbox.db`) turns that second delivery into an ack with no second task. A message that can't be recorded isn't acked, and Wald keeps it for the next poll.

A `response` never becomes a task. That is the loop guard: two instances cannot answer each other's answers forever.

### Trust

Wald's own rule decides what a sender name is worth: with `WALD_REQUIRE_AUTH=true` the sender is whoever holds the token; with it off, `from_agent` is a claim anyone can make, and anyone can read anyone's inbox. **Turn Wald auth on before trusting the mailbox with anything.**

On top of that, egirl decides what a message may *cause*:

- **Trusted senders** are the principal when it is an agent (`[report] to = "peer:<name>"`) and peers pinned in `[[peers]]`. Their requests become tasks.
- **Discovered peers aren't trusted.** Registering in Wald proves nothing about who you are (anyone who can reach it can register an `egirl-peer/1` row), so discovery answers "where is it", never "should I obey it". Pin a peer in `[[peers]]` to trust it.
- **Answers to delegated work** are accepted from the agent the work went to, on the thread it went out on. The thread id alone isn't enough, because it can be read.
- **A message Wald doesn't attribute** (a hub older than the `from_agent` field) is untrusted.
- **Everything untrusted** is data: recorded, fenced, run through the prompt-injection scanner, and reported to the principal. It never starts a run on this instance. If the principal is itself an egirl, the notice does run through *its* agent loop, like any report, framed as data.

A trusted request runs as an ordinary task under the normal safety layer. Being trusted grants no extra authority.

## Design Notes

- **Why synchronous request/reply?** A callback or queue design would need delivery state, retries, and a second protocol for replies. A blocking POST is one round trip, matches `/chat`, and the tool's timeout handles the slow case. The peer's session persists either way, so nothing is lost when a reply outlives the wait. When the other side can't be waited on, the mailbox is the asynchronous path, and the delivery state lives in Wald, not in egirl.
- **Why not a shared message bus?** One user, one cluster. Two instances talking directly over the API they already expose beats standing up infrastructure.
- **Trust model.** A peer is a semi-trusted principal: authenticated by token, but its messages are model-generated text. They run through the receiving agent's normal safety layer (command filter, path guard, audit log, prompt-injection scan) like any other input.
