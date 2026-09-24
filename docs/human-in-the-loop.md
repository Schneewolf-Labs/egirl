# The Human in the Loop

What egirl is for, stated as the job it does rather than the person it serves.

> Status: **foundation**. This names the model and maps it onto what already exists.
> The gaps at the bottom are the build queue, not a promise that any of it is designed yet.

## The job

An ordinary code agent has a person around it. That person does a handful of things the
agent can't do for itself: decides what to work on, approves or refuses risky actions,
notices when the work is drifting, checks the result, remembers yesterday, hands pieces
to someone else, keeps their own boss informed, and knows which decisions are above their
pay grade.

egirl does that job. Everything else in this repository is in service of one of those duties.

## Four directions

The duties sort by who they face.

```
                      principal (person or agent)
                               ▲
              inform · suggest · escalate  (report, standup, push)
                               │
   peers ◀── delegate ──── egirl instance ──── autonomy · continuity (self)
 (other egirls,                │
  Wald agents)   intent · authority · steering · verification
                               ▼
                   executors (code_agent, shell, browser, …)
```

| Direction | Duty | Mechanism today |
|---|---|---|
| **Down** | Intent | agent loop writing `code_agent` prompts |
| | Authority | `src/permissions/supervisor.ts` answers the code agent's permission, question, trust and confirmation prompts |
| | Steering | `spiral-guard`, `repetition-guard`, `nudges` |
| | Verification | only the "authoritative artifact" rule in `CLAUDE.md` |
| **Sideways** | Delegation | `peer_message` / `peer_list` over `egirl-peer/1`, synchronous; `delegate` through the Wald mailbox, asynchronous and to any registered agent ([peers.md](peers.md)); peer addresses resolved from a Wald registry (`src/peers/discovery.ts`) |
| **Self** | Autonomy | unbounded task runs, cron, the autonomy loop ([autonomy-loop.md](autonomy-loop.md)) |
| | Continuity | memory, `NOTES.md`, handoff, rollover, compaction |
| **Up** | Informing | `report` notify, heartbeat and standup, Web Push |
| | Suggesting | — |
| | Escalation | `report` ask, the `awaiting` task state, the ReplyBroker |

## Principal

Each instance answers to exactly one **principal**: the party whose intent it carries and to
whom it reports. The principal is whatever `[report] to` names — a person on a chat channel
or another agent (`peer:<name>`). On chat channels the principal is the `owner`; `allowed`
users can talk to the instance and use commands, but they are counterparts, not principals.

A person is a slow peer (`src/report/tool.ts`). A supervising egirl can field routine
questions itself and escalate only real decisions, so supervision stacks: Zero reports to
a supervisor instance, which reports to a person. Nothing in the code assumes the top of
that stack is a particular person.

More principals means more instances. An instance never serves two principals at once;
that is what keeps its memory, identity and authority unambiguous.

## Where Wald fits

[Wald](https://github.com/Schneewolf-Labs/Wald) is Schneewolf Labs' information hub for
agents and people: a wiki, a resource directory, an agent registry and an A2A mailbox,
exposed over MCP. It is the shared ground several of these duties stand on once there is
more than one instance:

| Wald pillar | Duty it serves | egirl today |
|---|---|---|
| Agent directory (`find_agents`, `register_agent`) | Delegation — who can take this work | announces itself with `register_agent` at startup, and reads `list_agents` to find `egirl-peer/1` peers (`src/peers/discovery.ts`) |
| Agent `owner` field | Principal — who an agent answers to | unused |
| A2A mailbox (`send_agent_message`, `read_inbox`, `ack_messages`) | Delegation and informing without both ends being up | `delegate` sends; a seeded `mailbox` task polls, records each message as a task or a conversation, then acks (`src/peers/mailbox*.ts`) |
| Wiki and resource directory | Intent and continuity — shared context beyond one instance's memory | reachable as an ordinary MCP server, not wired into recall |

Wald stays a tool, reached over MCP. It is not a routing layer and not a second workflow
engine; the local operator still decides what to send, to whom, and when.

## Gaps

In rough order of what they would change:

1. **Verification has no mechanism.** The operator takes `code_agent`'s summary on trust.
   A human would check the diff, run the tests, open the file the agent says it wrote.
2. **Suggesting doesn't exist.** egirl can notify and ask but never proposes: "this branch
   has been idle a week, close it?", "the task I finished unblocks X, start it?". A
   suggestion is an `ask` the principal may ignore; it probably needs its own lightweight
   form so it doesn't park a task waiting for an answer.
3. **Delegation trusts a sender name.** `delegate` hands work to any Wald agent, asleep
   or not, and a delegating task parks until the answer comes back through the mailbox
   ([peers.md](peers.md#mailbox-delegation)). What is left is trust: an inbound request is
   acted on when its sender is the principal or a pinned peer, and that name only means
   something with Wald's authentication on. Wald has no authorization of its own yet, so
   every trusted sender may ask for anything; there is no "this peer may only ask for
   reviews". Discovered peers are deliberately untrusted until pinned.
4. **The principal isn't one concept in code.** It is spread across `[report] to`, channel
   owner lists and the Wald `owner` field. Worth unifying only when something needs to ask
   "who is my principal?" in one place.
