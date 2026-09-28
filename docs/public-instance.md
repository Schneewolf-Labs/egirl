# Public Instances

An egirl instance can serve the public, for example as a lab's assistant behind a chat page. This doc covers the configuration and the contract with the web backend in front of it.

## The Framing

An instance still has one principal: here, the organization that runs it. Visitors are people it serves, not principals. They don't grant authority, they aren't `owner`, and they can't reach its memory, skills, tools or other visitors. That keeps "one principal per instance" intact: the instance is run *for* someone, and strangers talk *to* it.

Treat everything a visitor sends as untrusted. The question for every tool and every piece of shared state is what a hostile stranger could do with it.

## Configuration

Run a public instance from its own config (or its own `egirl.d/` fragment on a machine that runs nothing else). Fragments deep-merge over the base, and nothing can *unset* an inherited `[local.embeddings]`. A base config with memory turned on would give every visitor a shared memory.

```toml
[workspace]
path = "~/.egirl/luna"                 # SOUL.md, IDENTITY.md, lab facts in MEMORY.md, skills

[local]
endpoint = "https://llm.internal.example"   # operator model; EGIRL_LOCAL_API_KEY in .env
# No [local.embeddings]: without it there is no memory system, so no auto-extraction,
# no compaction flush, no proactive retrieval -- nothing one visitor says reaches another.

[channels.api]
host = "127.0.0.1"                     # only the web backend talks to it
port = 3100
max_sessions = 200                     # drop least-recently-used idle sessions past this

[tools]
files = false
exec = false
process = false
git = false
memory = false
browser = false
github = false
tasks = false
code_agent = false
peers = false
screenshot = false
session_search = false                 # it searches every visitor's conversation
skill_manage = false                   # also turns off /learn
consult = true
consult_files = false                  # the workspace holds every visitor's conversations.db
web_research = true
web_research_private = false           # no loopback / private / link-local / CGNAT targets
web_search = true

[searxng]
url = "http://127.0.0.1:8888"

[[consultants]]
name = "frontier"
endpoint = "https://api.example.com"
model = "..."                          # key: EGIRL_CONSULTANT_FRONTIER_KEY in .env

[conversation]
max_age_days = 7                       # visitor transcripts are kept this long
```

Leave `[report]` out unless the principal wants to hear from the instance. Every visitor can trigger it, so a configured `report` target will get their noise.

The workspace files (`SOUL.md`, `IDENTITY.md`, `MEMORY.md`, skills) are the principal's. Nothing above lets a visitor change them.

## The Web Backend's Contract

The backend in front of the instance (the chat page's server) owns everything about visitors. egirl only sees sessions.

- **Forward only `POST /chat`.** Never proxy `/sessions`, `/memory`, `/tasks`, `/prompt`, `/info`, `/peer/*`, `/push/*` or `/`. They are the principal's console.
- **Build the body yourself:** `message`, `stream`, and `session_id`. Add `images` only if the operator model has vision and you want visitors sending pictures. Drop everything else the browser sent.
- **Assign `session_id` server-side**, e.g. `visitor:<random>` bound to the visitor's cookie. Never accept one from the browser: prefixes like `task:` and `peer:` mean something to egirl, and a guessed id is another visitor's conversation.
- **Hold the bearer token** (`EGIRL_API_TOKEN`) server-side.
- **Rate-limit per visitor**, with a smaller budget for turns that call `consult`, since those cost money. egirl's API deliberately has no rate limiting.
- **Tell visitors** that conversations are stored (for `max_age_days`) and whether they are used for training.

## Scaling

One process serves many sessions at once. Throughput is bounded by the operator model's server (`--parallel` slots on llama-server), not by egirl. `max_sessions` bounds memory: an evicted session is rebuilt from `conversations.db` when the visitor comes back. A session that is running or has a turn queued is never evicted.

Past one process, run several identical instances, each with its own workspace and port, and have the backend pin each visitor to one of them. They share nothing, which is the point: more instances, not a multi-tenant one.

## Known Gaps

- **DNS rebinding.** `web_research` checks the addresses a host resolves to and re-checks every redirect hop, but the fetch resolves the host again. A hostile DNS server that answers public then private can slip past. Plain `http://10.0.0.5/` and `http://localhost/` are refused.
- **Prompt injection from the web.** A fetched page can tell the model to do things. With the tool set above, the worst it can do is make the answer wrong or make `consult` spend money.
- **Transcripts.** `conversations.db` holds every visitor's conversation until `max_age_days`. It never leaves the host through the configuration above, but it is there.
