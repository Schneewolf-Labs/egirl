# Core Loop — Specification

The semantics of one agent run: the ordered stages of a turn, every way a run can
end, the recovery ladder, and the invariants any implementation must preserve.

> Status: **normative description of implemented behavior.** The TypeScript under
> `src/agent/` is the reference implementation; where this document and the code
> disagree, the code is the bug or this document is stale — either way, fix the
> mismatch. The behavior tests in `test/agent/` are the conformance suite: a port
> of this loop to another language should reproduce their observable behavior.
> The *control model* for indefinite runs (why unbounded runs exist, semantic vs
> mechanical stops) is [autonomy-loop.md](autonomy-loop.md); this document is the
> mechanical contract underneath it.

Vocabulary: a **run** is one call to `AgentLoop.run()` — from a user message to a
final response. A **turn** is one iteration of the run's loop: at most one
inference plus whatever that inference triggers (tool execution, a recovery
retry, acceptance). `RunState` (`run-state.ts`) is the complete mutable state of
a run; everything in it resets between runs, and nothing outside it (history,
context, compaction chain) does.

## 1. Turn pipeline

### Run setup (before the first turn)

1. **Drain compaction.** Await any in-flight background summarization so this
   run reads a settled conversation summary, never a half-written one.
2. **Abort plumbing.** Every run gets its own abort controller; an external
   signal (task timeout, shutdown) forwards into it. The loop body watches
   exactly one signal.
3. **Turn cap.** `maxTurns` (default 10), unless the run is unbounded — then the
   cap is replaced by the safety ceiling (see §4).
4. **Append the user message.** In planning mode the message is wrapped in the
   planning-mode prompt **and tool definitions are withheld from every turn** —
   a plan is produced from reasoning alone, never from tool use. Attached images
   ride the same message as `image_url` content parts.
5. **Memory recall.** Relevant memories are injected as a marked recall message.
   Recall messages are regenerated per run and never persisted.
6. **Run state.** A fresh `RunState`; recovery caps resolved from `[recovery]`
   config over the defaults (§3).

### Stages of one turn

Each iteration runs these stages in order:

1. **Abort check.** A set signal ends the run before any work.
2. **Deliver injections.** All operator messages queued by `inject()` since the
   last boundary land here — the queue drains in order, each wrapped in the
   interjection nudge as an ordinary user message. Never mid-turn, where a user message between an assistant tool call
   and its results would corrupt the transcript the model sees.
3. **Consolidation break** (only when `consolidationInterval > 0`). One
   checkpoint nudge telling the agent to externalize what it has learned. Two
   triggers, one mechanism: the interval trigger fires every N turns; the
   context-pressure trigger fires when the last prompt filled ≥ 80% of the
   context window — the moment before compaction, when durable capture matters
   most — rate-limited to one per interval window.
4. **Wrap-up warning** (only when a `deadline` is set). Once per run, when the
   hard deadline is within the wrap-up margin (default 7 min): stop starting new
   work, checkpoint, conclude. Turns the caller's timeout guillotine into a
   self-directed wind-down.
5. **Context assembly + inference** (`chat.ts`, `context-window.ts`):
   1. The conversation summary, if any, is folded into the **system prompt** —
      never sent as a second system message (§2, invariant 1).
   2. **History hygiene** (render-time only; the store keeps the full record):
      old call/result pairs whose calls are *all* empty-args against tools that
      require arguments are pruned, keeping only the most recent such pair — the
      model should see that its last attempt failed, but older ones are
      in-context demonstrations of the malformed shape it will imitate.
   3. **Fit to the window.** Budget = context length − output reserve (2048) −
      system prompt − tool definitions. Individual tool results are truncated to
      8000 tokens **unconditionally, before the budget is measured** (data-URL
      images are exempt from truncation and counted at a flat 1000 tokens — half
      a base64 image is a corrupt image, not a shorter one). Then, escalating
      only as needed: if over budget, **stale tool outputs are cleared in
      place** — content blanked to a marker, message kept
      so the transcript shape stays valid — outside a protected recent tail
      (min(8000 tokens, 25% of budget)) and never in the in-flight trailing
      group; if still over, messages are **grouped** (an assistant message with
      tool calls plus its following tool results is one atomic group), the head
      group is protected when it fits in ≤ 30% of budget, and the most recent
      groups that fit are kept from the end. Dropped middle groups are returned
      for compaction and a truncation notice is inserted in their place.
   4. Two hard guarantees on the fitted result: the **most recent group always
      survives**, even oversized (it is then hard-trimmed to budget — losing the
      tail of one tool result is survivable, losing the turn being answered is
      not), and **at least one user message survives** (an anchor is re-inserted
      if fitting removed them all).
   5. **Send with classified retries.** Transient/rate-limit errors retry with
      backoff; auth/billing errors fail fast. Two self-healing retries ride this
      path: a text-only endpoint rejecting images → images stripped to text
      markers and the request retried; a server whose real `n_ctx` is smaller
      than configured → refit to the server's number and retried.
   6. If fitting dropped messages and compaction is enabled, the dropped
      messages are **scheduled for background compaction**: pruned from the live
      context immediately, summarized on the auxiliary provider, the result
      folded into the conversation summary. Summarizations chain — overlapping
      ones never race on the summary. The summary is bounded (§2, invariant 6).
      With **context rollover** on instead (`context_rollover`, or any unbounded
      run), fitting that would drop messages retires the whole window: the
      request is sent on a fresh window holding one mechanical handoff record
      (`src/agent/handoff.ts`), the live context adopts it afterwards, the
      transcript stays append-only, and the retired messages get the same
      memory flush — no summary is ever generated. The model can also trigger
      this itself with `new_context`, applied atomically after its tool batch.
6. **Bookkeeping.** Usage totals, the context-pressure measure for stage 3,
   transcript/trace records, token-budget warnings, thinking surfaced to events.
7. **Guards.**
   - *Reasoning loop (within one inference):* if the thinking block is dominated
     by verbatim repetition, abort the run — this loop never escapes a single
     turn, so the cross-turn detector below cannot see it.
   - *Cross-turn spiral (tool-calling turns only):* each tool-calling turn is
     fingerprinted as content prefix (240 chars, whitespace-collapsed) + exact
     sorted `name:arguments` calls + thinking prefix (240 chars). The same
     signature 3 times within the trailing 4 turns aborts the run before the
     repeated call burns another turn. Empty signatures are ignored (they belong
     to the empty-response rule); non-tool turns are not counted (the recovery
     paths return identical responses by design and carry their own caps).
8. **Tool phase** (when the response carries tool calls), under the session
   mutex — inference runs *outside* the lock so a batching server can serve
   concurrent sessions; only tool execution, which races on the workspace, is
   serialized. The assistant message (content + calls) is appended, then calls
   execute under the **sequential-mutating / concurrent-read contract**:
   mutating tools (`execute_command`, `write_file`, `edit_file`, `git_commit`,
   `code_agent`, `process_*`) run strictly in emission order; everything else
   runs concurrently alongside them. Each result is truncated at ingestion
   (8000 tokens) and appended as a tool message paired to its call id. A call
   repeating an earlier call's exact name + arguments (tracked per run) appends
   a loop-warning nudge after the results. If the run was aborted mid-phase,
   unstarted calls get skip results so pairing survives (§2, invariant 3). Then
   the next turn begins.
9. **Recovery ladder** (no tool calls; §3). First matching rule decides:
   *retry* → next turn; *abort* → the rule's final content is persisted as the
   assistant message and the run ends; *accept* → fall through.
10. **Acceptance.** Stranded tool-call markup still present after recovery is
    exhausted is stripped (the model must not print raw broken XML at the user).
    The final content is any accumulated continuation prefix plus this piece;
    the assistant message persists only this turn's piece.
11. **Post-response validation** (when the caller registered a validator; at
    most once per run). A rejection appends the validation-failed nudge, resets
    the continuation accumulator, and re-enters the loop.
12. **Return or break.** Planning mode returns the accepted response immediately
    as a plan (`isPlan: true`); otherwise the loop breaks with the final
    content.

### After the loop

- **Turn-cap exhaustion** with no final content and no abort forces one extra
  no-tools inference (the max-turns summary nudge) so the model reports where it
  got to instead of the caller receiving a stale message; if even that fails or
  returns empty, a fixed fallback marker is the response. An unbounded run
  reaching here is additionally logged as an error — a detector failed (§4).
- **Auto-extraction** of memories from the new messages is scheduled in the
  background (skipped on the planning-mode early return).
- **`finally` — runs on every exit, including thrown provider errors:** the
  active-run slot clears, new messages persist to the conversation store
  (filtering recall and ephemeral messages, sanitizing stranded markup — §2,
  invariant 4), and the transcript turn closes. A crash mid-run must not lose
  the user message and tool activity already in context.

## 2. Context economy contract

Invariants every implementation must preserve. Most were bought with an
incident; the code comments at the cited sites carry the war stories.

1. **Exactly one system message, always first.** The conversation summary folds
   into the system prompt; any stray system message found in history is hoisted
   into it. Qwen's chat template hard-rejects a system message at any other
   position, failing the entire request. (`chat.ts`)
2. **At least one user message survives fitting.** The same template rejects a
   conversation with no user turn — the exact shape a long tool-heavy run
   reaches once its head group is dropped. (`context-window.ts`)
3. **Call/result pairs are atomic.** An assistant message with tool calls and
   its following tool results move together: fitted as one group, pruned as one
   pair by hygiene, and completed with skip results when an abort interrupts the
   phase. A tool result without its call, or a call without results, corrupts
   the transcript for every later turn.
4. **Persistence is the poison boundary.** Ephemeral messages (a mangled call
   and its reissue nudge) and recall messages never reach the store; assistant
   content is sanitized of stranded markup at persistence. Anything stored
   reloads into every future session as an in-context demonstration — persisted
   failures teach the model to fail. (`history.ts`)
5. **Injections land only at turn boundaries.** (§1 stage 2.)
6. **The summary is bounded and non-droppable.** Capped at 8000 chars keeping
   the tail, ≤ 500 tokens per summarization; it lives in the system prompt, so
   fitting can never drop it. An uncapped summary once grew to ~178k tokens —
   three times its context — and broke every request. (`context-summarizer.ts`)
7. **The current turn outranks the budget.** The most recent group survives
   fitting even when oversized, then is hard-trimmed; dropping it leaves the
   model answering a deleted question, and it confabulates a new task.
8. **Clearing preserves shape.** Stale tool outputs blank to a marker; the
   messages (and the calls beside them) remain. The protected tail and the
   in-flight trailing group are never cleared.
9. **Prompts are data.** Every nudge the loop injects lives in `nudges.ts`; the
   loop bodies are control flow only. A port shares the strings verbatim.
10. **Inference outside the lock, tools inside.** The session mutex serializes
    only the tool phase; two runs may interleave turn by turn, so nothing may
    assume it holds the lock across a whole run. (`session-mutex.ts`)

## 3. Recovery ladder

Applied to a response with no executable tool calls (`recovery.ts`). Rules are
walked in order; the first whose predicate matches decides the turn. A matched
rule with retries left **fires** (queues a nudge or a silent retry) and the loop
runs another turn; an exhausted rule falls through to the next rule — and past
the last rule to acceptance — unless it declares an exhaustion abort. A rule's
abort-instead-of-retry check runs only while a retry is actually available.

| # | Rule | Predicate | Cap (config key, default) | On fire | Exhausted |
|---|------|-----------|---------------------------|---------|-----------|
| 1 | continuation | `finish_reason = length` and content non-empty | `continuation_retries` (3) | persist the partial content as an assistant message + the continuation nudge; accumulate the partial | fall through — the truncated piece is accepted as final |
| 2 | stranded tool call | unparseable `<tool_call>` markup in content | `nudge_retries` (3) | *ephemeral* assistant echo + *ephemeral* reissue nudge; resets the continuation accumulator and counter | fall through — acceptance strips the markup |
| 3 | empty after tools | empty content, tools ran this run | `nudge_retries` (3) | *ephemeral* nudge pointing at the ignored tool results | fall through — the empty reply is accepted |
| 4 | empty response | empty content, no tools ran | `empty_retries` (2) | silent retry — no message added; the identical request re-sends (cheap: the prefill is KV-cached) | **abort** with the empty-response marker |

Rule 1's abort-instead-of-retry: a repetition-dominated truncation (the model
spent its whole output budget echoing one fragment) aborts with what has
accumulated plus an abort marker — continuing would stitch more of the echo on.

Rule 4's extra gate (the **deterministic-empty rule**): two consecutive attempts
with `output_tokens = 0` prove the same prompt will keep producing the same
empty, so remaining budget is skipped and the rule aborts. An attempt that
generated *something* (output tokens spent, content empty — reasoning ate the
budget, or think-stripping ate the text) keeps its budget: sampling can land
differently next time.

Rules 1 and 2 differ deliberately in persistence: a truncated response is real
work in progress and persists; a mangled call is a failure and is ephemeral
(§2, invariant 4).

**Repetition dominance** (shared by rule 1's abort, the reasoning-loop guard,
and via the spiral detector): a fragment ≥ 600 chars where one normalized line,
or one exact 60-char window, repeats ≥ 5 times and covers ≥ 50% of the fragment.
Deliberately conservative and fail-open — ordinary truncation is never flagged.

## 4. Termination taxonomy

Every way a run ends. In all cases the `finally` post-conditions of §1 apply:
new non-ephemeral, non-recall messages persist, and the transcript turn closes.
`awaitingInput` is not a termination path — it is a flag set on the response
whenever a tool reported waiting on supervisor input, whatever ends the run.

| Outcome | Trigger | Final content | Extra post-conditions / caller sees |
|---------|---------|---------------|-------------------------------------|
| Conclusion | model returns text, validation passes | accumulated + accepted piece | the normal case |
| Plan | planning mode's first accepted response | the plan text | `isPlan: true`; auto-extraction skipped |
| Reasoning-loop abort | thinking dominated by repetition | accumulated + content + abort marker | assistant message persists the raw content |
| Spiral abort | same turn signature 3× in 4 turns | accumulated + content + abort marker | assistant message persists the raw content |
| Recovery abort | ladder rule 1 (repetition-dominated truncation) or rule 4 (empty exhausted/deterministic) | the rule's content incl. marker | the marker content itself persists as the assistant message |
| Signal abort | `interrupt()`, caller signal (timeout, shutdown) — checked at turn start, during inference, after tools | whatever had accumulated (often empty) | `aborted: true`; unstarted tools got skip results |
| Turn-cap exhaustion | `turns ≥ maxTurns` with no final content | forced no-tools summary, or the fixed fallback marker | one extra inference beyond the cap |
| Unbounded ceiling | 10 000 turns on an unbounded run | as turn-cap exhaustion | logged as an **error**: a failure detector should have fired first — this is a bug signal, not a limit |

The design intent (see [autonomy-loop.md](autonomy-loop.md)): a healthy
unbounded run ends only on a *mechanical* failure the detectors catch, a
*semantic* stop the agent reports itself, or a human. The ceiling exists so a
detector gap cannot run forever silently.

## 5. Steering semantics

What a caller can do to an in-flight run, today:

- **`inject(message)`** — queue a message into the running turn loop. Delivered
  at the top of the next turn as a user message wrapped in the interjection
  nudge (§1 stage 2). Returns `false` when nothing is running — the caller
  should send a normal chat message instead.
- **`interrupt()`** — abort the in-flight run through the same signal path as
  every other abort, cancelling even a stuck inference. Returns `false` when
  nothing is running.
- **`isRunning()`** — whether a run is in flight (one run at a time per loop
  instance is the contract everywhere).

A richer steering ladder — distinguishing *steer* (adjust course, keep the run)
from *redirect* (replace the goal) from *interrupt* — is a **planned extension**,
not implemented. Today an injection is advisory (the interjection nudge tells
the model the message may redirect or end the work, but the model decides) and
interrupt is total. Any future ladder must preserve invariant §2.5: steering
content enters only at turn boundaries.

## Constants

Gathered here for auditability; each is defined (with fuller rationale) at the
cited site. Configurable values name their `egirl.toml` key.

| Constant | Value | Config key | Where | Why this value |
|----------|-------|------------|-------|----------------|
| default turn cap | 10 | `maxTurns` run option | `loop.ts` | interactive default; tasks pass their own |
| unbounded safety ceiling | 10 000 | — | `loop.ts` | far beyond real work; reaching it means a detector bug |
| context-break threshold | 0.8 | — | `loop.ts` | matches the `/context` "getting tight" threshold |
| wrap-up margin | 7 min | `wrapupMarginMs` run option | `loop.ts` | room to checkpoint before the caller's timeout |
| continuation retries | 3 | `recovery.continuation_retries` | `recovery.ts` | |
| recovery nudges | 3 | `recovery.nudge_retries` | `recovery.ts` | one was measurably not enough for a 27B under context pressure |
| empty retries | 2 | `recovery.empty_retries` | `recovery.ts` | retries are cheap (KV-cached identical request); the deterministic-empty rule usually ends them earlier |
| spiral window / threshold | 4 / 3 | — | `spiral-guard.ts` | same signature 3× in 4 turns |
| signature fingerprint | 240 chars | — | `spiral-guard.ts` | loops re-enter on the same opening thought |
| repetition: min fragment / window / repeats / dominance | 600 / 60 / 5 / 0.5 | — | `repetition-guard.ts` | ported intact from hermes-agent |
| output reserve | 2048 tokens | — | `context-window.ts` | room for the response inside the window |
| tool-result cap | 8000 tokens | — | `context-window.ts` / `tool-runner.ts` | applied at ingestion and again at fitting |
| image cost | 1000 tokens | — | `context-window.ts` | flat cost once converted to an `image_url` part |
| clear-protect tail | min(8000, 25% budget) | — | `context-window.ts` | a fixed tail inside a small budget would protect everything |
| clear minimum | 200 tokens | — | `context-window.ts` | the marker costs tokens too |
| head-group protection | ≤ 30% of budget | — | `context-window.ts` | keep task context without starving the tail |
| summary cap | 8000 chars / 500 tokens | — | `context-summarizer.ts` | an uncapped summary once outgrew its own context |
| provider retries | 2 | — | `chat.ts` | classified: transient retries, auth fails fast |
| mutex acquire timeout | 10 min | — | `session-mutex.ts` | one hung tool call must not deadlock every entry point |

## Porting notes

The loop is close to a sans-IO design: the decision logic is pure, the effects
sit at the edges. A port should draw the same line.

**Pure — transcribe directly, verify against the conformance tests:** the
recovery ladder and its walker, `RunState` and its transitions, both guards and
the shared repetition-dominance check, the turn signature, the fitting policy
(given a token counter), history hygiene, the nudge strings, the invariants of
§2.

**Edges — replace with the target language's idiom:** cancellation
(`AbortController`/`AbortSignal` here; any cooperative token checked at the
same three points works), streaming callbacks (the `events` handler), timers
and backoff (`setTimeout`), the tokenizer (an HTTP client for llama.cpp's
`/tokenize`, with the char-ratio estimate as fallback), the conversation store
(SQLite), background scheduling (promise chains for compaction/extraction), and
`Date.now()` for the deadline logic. One economic dependency deserves care:
per-session KV cache-slot pinning (`cache-slots.ts`) is what makes an identical
retry nearly free — the empty-retry budget (§3 rule 4) assumes it. A port to a
server without per-slot prefix caching should reconsider `empty_retries` rather
than inherit the value.

Two JS-specific behaviors that are contracts, not accidents: tool results are
appended deterministically regardless of concurrent completion (the mutating
calls' results first, then the concurrent calls', each in emission order — and
every result is tied to its call by id, so pairing never depends on ordering),
and the compaction chain guarantees summarizations apply in schedule order.
