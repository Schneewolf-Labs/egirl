# Autonomy Loop — Indefinite Agent Operation

How an egirl instance runs a long-lived goal on its own: the control model, what
stops it, how it survives its own context window, and how it involves a supervisor
(human *or* agent) when it reaches the edge of what it can decide alone.

> Status: **proposal**. Written after a full day of running Zero unattended on a
> reverse-engineering task surfaced, one at a time, every place the loop was held
> together by a human being present. This is the spec for removing that assumption.

## Thesis

egirl's premise is that **the agent is the human in the loop.** In an ordinary
agent harness a person supplies the judgment the model lacks: when to stop, when to
keep going, when the work has drifted, when to write things down, when to ask for
help. Run the agent unattended and every one of those becomes a gap that has to be
real code — because there is no longer a person to catch it.

The goal of this loop is a single instance that can be pointed at a goal, left
alone for days, and either finish it or come back with a specific question — on
owned hardware, where compute is not the constraint. It should run indefinitely by
default and stop only for reasons that genuinely warrant stopping.

## The two kinds of stop

Everything that ends or pauses a run falls into one of two categories. Keeping them
separate is the core design decision.

| | Trigger | Who resolves it | Response |
|---|---|---|---|
| **Mechanical** | stuck inference · reasoning/repeat spiral · context exhaustion | the system, automatically | abort · abort · recycle |
| **Semantic** | blocked on a decision · goal exhausted | a supervisor (human or agent) | `ask` / `notify` and await |

Mechanical stops are failures of the *machinery* and the agent cannot reason its way
out of them, so the system handles them without anyone's involvement. Semantic stops
are the *boundaries of the agent's authority* — it has done all it can decide on its
own — so it reports out and waits. Artificial limits that are neither (a fixed turn
cap, a wall-clock guillotine) are removed; they only ever existed as crude proxies
for the real failure detectors below.

## The loop

```
   ┌───────────────────────────── run (indefinite) ──────────────────────────────┐
   │                                                                              │
   │   orient from NOTES.md ──▶ work ──▶ work ──▶ [break] ──▶ work ──▶ ...         │
   │        ▲                                       │                             │
   │        │                              consolidate to disk                    │
   │        │                              (notes + artifacts)                    │
   │        └──────────── recycle from NOTES ◀── context pressure                 │
   │                                                                              │
   │   any turn may: hit a mechanical stop (abort/recycle)                        │
   │                 reach a semantic boundary (ask/notify a supervisor, await)   │
   │                 be interrupted by a human (esc / inject)                     │
   └──────────────────────────────────────────────────────────────────────────────┘
```

A run is no longer a fixed budget of turns that ends. It is a continuous loop over a
goal, punctuated by **consolidation breaks**, terminated only by a mechanical failure,
a semantic report, or a human. The hourly task scheduler stops being the unit of work
and becomes, at most, a heartbeat that restarts a loop that a mechanical failure ended.

## Components

### 1. Consolidation breaks

Every *N* turns **or** when context crosses a utilization threshold — whichever comes
first — inject one system turn:

> `[System: Checkpoint. Write everything learned since your last checkpoint into
> NOTES.md, save any artifacts under work/, then continue.]`

One mechanism, three triggers: every *N* turns, on context pressure, **and** as the
run's wall-clock time budget nears (the task timeout). The time trigger injects a
wrap-up-and-conclude nudge a margin before the hard deadline, turning what was a
mid-inference guillotine into a self-directed wind-down. Crucially, an unbounded run
that reaches its time budget is treated as a **checkpoint boundary, not a failure** — it
does not count toward the auto-pause failure tally, because a healthy long-running task
hitting the clock is expected, not a fault. (This gap — "unbounded" not exempting a run
from the wall-clock timeout, and the timeout counting as a failure — was found in
production when Zero's task auto-timed-out at 50 min and logged a failure; fixed by the
time-trigger wrap-up plus the not-a-failure treatment.)

It does three jobs at once:

- **Note collection** — the durable record stays current instead of being written
  once at a run's end (which, under any interruption, never happens).
- **Breaks a reasoning rut** — forcing an externalize-and-continue is the cheapest
  way to pull a model out of spinning on the same thought.
- **Creates a restore point** — see context exhaustion below. This is the one that
  makes indefinite operation actually possible.

Observed failure it fixes: a run did 50 minutes of real analysis and was cut off
before writing a word, because "update your notes" was a *final* step and the run
never reached its end.

### 2. Stuck inference → abort the inference

Already built: the stale-stream timeout in the llama.cpp provider, with
per-model-family floors (`reasoning-floors.ts`) so a reasoning model's thinking phase
is not mistaken for a hang. If a stream produces neither content nor reasoning tokens
for the timeout, the inference is aborted. **No change needed.**

### 3. Reasoning / repeat spiral → abort the run

Partly built: `spiral-guard.ts` fingerprints each turn (content + exact tool
name/args) and aborts when a signature recurs 3× in a 4-turn window. **Gap:** it is
scoped to *tool-executing* turns, so a pure-reasoning loop — the model restating the
same thinking turn after turn without calling a tool — slips through. It was scoped
that way to avoid pre-empting the stranded/continuation/empty recovery paths, which
return identical responses by design.

**To build:** extend the detector to count no-tool reasoning turns too, while still
excluding the bounded recovery paths. That closes the "thinking death spiral" case.

### 4. Context exhaustion → recycle from NOTES

This is the fundamental limit on "indefinite," and the reason the consolidation break
matters more than it first appears. An unbounded run accumulates messages until they
no longer fit. Naive compaction (summarize old messages away) is lossy — over a long
run it is a telephone game, and it can itself fail ("LLM returned empty summary").

The insight: **if the important state lives on disk (NOTES.md, work/), the
conversation is disposable.** So context exhaustion becomes a *managed transition*,
not a failure:

1. Utilization crosses a threshold (~80%; already tracked for the `/context` bar).
2. That fires a consolidation break — urgency-flagged: *write everything durable now.*
3. The context is **reset to system-prompt + NOTES.md**, and the agent re-orients from
   its own notebook. Zero information lost, because NOTES.md was built to be the
   complete orientation doc.

**Reset-from-NOTES vs. compaction.** Reset is preferred over lossy summarization:
compaction tries to preserve the conversation; reset admits the conversation is
scratch and the files are memory. Reset has no decay, and it continuously *audits*
the capture discipline — if a reset loses something, that something should have been
in NOTES.md and wasn't. The context window stops being the ceiling on run length; the
disk (effectively unbounded) is.

The genuine failure here is narrow: if consolidate-then-reset still cannot recover
headroom (NOTES.md itself grew pathological, or the write failed). That escalates as
a semantic stop.

**Shipped as context rollover** (`src/agent/handoff.ts`, `src/agent/rollover.ts`; the
idea is fitchmultz/pi-posthorse). When fitting would drop messages, the whole window is
replaced by one mechanically built handoff record — the operator's inputs verbatim,
supervisor replies to `report` asks, the trailing tool batch the model has not yet
answered, and whatever the model handed over itself — with no LLM call. Older assistant
prose and consumed tool results are not treated as state. The transcript stays
append-only in the conversation store (the record marks where the live window starts on
restart) and `session_search` reaches all of it. The model gets `context_remaining` and
`new_context({ handoff })` to roll over on its own terms right after a checkpoint. On
for unbounded task runs; `conversation.context_rollover` turns it on everywhere else.
The cheap reclamation tiers (tool-result truncation, stale-output clearing) still run
first — rollover replaces only drop-and-summarize.

### 5. Human interject — esc, anytime

Built for the interactive CLI (`captureDuringRun`: esc interrupts, typed input
queues). **Gap:** a background task run has no TTY, so esc cannot reach it. For the
unattended case, a human interject needs a channel:

**To build:** an API `POST /sessions/:id/interrupt` (abort or inject a message into
the running loop). The task runner already holds an `AbortController` per running
task; this exposes it. That makes "the human can always stop the loop" true for
background runs, not just interactive ones.

### 6. Semantic boundaries → `report` to a supervisor

When the agent reaches the edge of its own authority, it does not guess and it does
not grind — it reports out and waits. Two triggers, two modes.

**Triggers**

- **Clarification** — an ambiguity or a decision only the supervisor can make.
  *(The poster child: three runs burned on a Ghidra scriptPath error a colleague
  would have asked about in one message.)*
- **Goal exhausted** — the objective is complete. Without this, a finished agent
  either idles or invents busywork to look productive.

**Modes**

- **`ask`** — two-way, blocks for a reply. *"Which Civ 5 build — DX11 or DX9?"*
- **`notify`** — one-way, fire-and-forget. *"Done. Type-1 cracked, summary in NOTES.md."*

Clarification is always an `ask`; goal-exhausted is either (`notify` to stop and
await a new objective, or `ask` to request direction now).

**Reuse, don't add a silo.** `peer_message` already *is* report-and-await for an
agent supervisor: send a message, block, the peer runs its own loop, the reply comes
back as the result. So the agent-supervisor case largely exists today. The gap is
agent→human — and the clean framing is that **a human is just a slow peer**: the same
"send, block, reply" abstraction, where the reply comes from a person on
Discord/XMPP instead of an agent loop.

So the design is **one `report` tool**, not a new `notify_user`:

```
report(target, mode, message)
   target: a configured supervisor — a peer agent, or a human channel (discord/xmpp/api)
   mode:   "ask"    → block, await a reply, return it   (rides peer_message's await machinery)
           "notify" → send, return immediately
```

`report_to` is per-instance config. Crucially it can be **an agent or a human**, which
makes the supervision *fractal*: Zero reports to a supervisor egirl that fields routine
clarifications autonomously and escalates only genuine decisions up to the human. Stack
it as deep as the work warrants, human at the top. That is "the agent is the human in
the loop," recursively.

## What exists vs. what to build

| Component | State | Work |
|---|---|---|
| Stuck-inference abort | **done** | — |
| Spiral guard (tool loops) | done | extend to reasoning-only loops |
| Consolidation break | — | inject on turn-interval **or** context threshold |
| Context recycle-from-NOTES | **done** (`context_rollover`, on for unbounded runs) | — |
| Unbounded run mode | turn cap / wall-clock exist | make caps a far-off safety net, not the stop |
| Human interject (background) | interactive only | `POST /sessions/:id/interrupt` |
| `report` (ask/notify) | `peer_message` (agent await) exists | unify: `report_to` = agent **or** human channel |

## Sequencing

Two phases, ordered by "closest to done" and "helps the running agent tonight."

**Phase 1 — mechanical + breaks** (self-contained, immediate value):
extend spiral to reasoning loops · consolidation break (turn + context triggers) ·
reset-from-NOTES on context pressure · unbounded-run mode. After this, an instance
runs indefinitely, checkpoints itself, survives its own context window, and stops
only on genuine mechanical failure.

**Phase 2 — semantic + interject** (the supervision layer) — SHIPPED:
task lifecycle over HTTP (`POST /tasks/:id/pause`|`resume`, `DELETE /tasks/:id`) ·
`POST /sessions/:id/interrupt` (abort, or inject a message delivered at the next turn
boundary — task sessions route through the runner) · the `report` tool (`[report] to`
in egirl.toml: `peer:<name>` rides the peer protocol; `xmpp:<jid>`/`discord:<id>` ride
outbound send plus the ReplyBroker, which routes the human's next inbound message to
the parked ask instead of a new run) · the awaiting-input state (an unanswered ask
sets `awaitingInput` on the tool result, surfaces through `AgentResponse`, and parks
the task as `awaiting`; a chat reply on the task's session — persisted into its
conversation — resumes it with `next_run_at = now`, so the reply seeds the next run) ·
trigger guidance injected into unbounded task runs (blocked → `ask`; goal-done →
`notify`/`ask`).

## Open questions

- **Reset-from-NOTES leans entirely on capture discipline.** It is only safe once the
  agent reliably writes everything durable to NOTES.md/work. Rollover is therefore on
  for unbounded runs (whose contract already mandates the discipline) and opt-in
  elsewhere; lossy compaction stays the default for chat sessions. Treat a rollover
  that loses tracked progress as a bug in the capture prompt.
- **`ask` blocks a run indefinitely waiting on a human.** Resolved: an ask waits up
  to `ask_timeout_ms` (default 30 min), then parks the task as `awaiting`; the reply,
  sent to the task's session, is persisted into its conversation and reactivates it.
- **Loop-driver vs. supervisor model boundary.** For the RE phase a capable local
  operator (Qwen3.8-27B) does the work directly and delegation would only cost context
  continuity. If the work later shifts to heavy code generation, the lever is a
  stronger *operator*, not a delegation hop — the reset-from-NOTES and sandbox
  properties depend on unified context.

## Why this is general

None of this is task-specific. It is the egirl autonomy engine — the same loop runs
Kira, the XMPP agents, and any future instance. The reverse-engineering work that
surfaced these gaps was the shakedown; the loop is the product.
