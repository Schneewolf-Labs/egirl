# Context survival: reset from NOTES, not compaction

Status: proposal. Delivers the `### 4. Context exhaustion → recycle from NOTES` component
that [docs/autonomy-loop.md](autonomy-loop.md) deferred until capture discipline was proven.
It is proven now (see "Why it's safe now").

## Thesis

**The conversation is scratch space, not the record.** In an unattended run the durable state
lives outside the message history — in NOTES.md (the live lab notebook), the work/ artifacts, and
memory. The conversation is the model's working memory for the current thought: useful now, mostly
disposable after the finding is written down. So the right way to bound context is not to
accumulate the whole history and then lossily summarize it — it is to periodically **throw the
scratch away and rebuild the working context from the durable record.**

## The problem, as observed

An instance degrades well before it hits its context limit. Measured on Zero, on a 164k window:
at ~77% utilization (~126k tokens) she stopped engaging — she would reload the huge context, emit
a summary with no tool calls, and end the run after a single inference, then sit idle until the
next scheduled one. Not a crash; a *drowning*. The model, handed more context than it can hold a
thread through, retreats to summarizing instead of working.

The fix that day was manual: drop `context_length` from 164k to 64k so she operated in a window
she could actually think in. It worked — one inference-and-quit became a 63-inference grind. But
it is a static knob turned by hand, and setting it forced a full compaction on the next load
(a cold-prefill cache miss), because 300+ messages had to be trimmed to fit at once.

Two things are wrong here:
1. **There is no adaptive mechanism.** The working window is a hand-tuned constant. Too big and
   the model drowns; too small and it forgets recent work. Nobody is watching for either.
2. **Compaction is the wrong tool for a NOTES-driven agent.** Today's fallback is to summarize the
   dropped middle of the conversation — but that middle is *already summarized*, in NOTES.md, by
   the agent, in its own words, as it worked. Compaction re-derives (worse, and repeatedly) a
   record that already exists on disk.

## The design: reset from NOTES

Treat the conversation as disposable and rebuild it from the durable record on a rhythm.

**A working-window target, distinct from the hard limit.** `context_length` stays as the server
ceiling. Add a *target* — the size the model actually works well at, well below the ceiling — that
the loop actively keeps the live conversation under. (64k held for a 27B; it should be tunable,
and eventually adaptive — see Phase 4.)

**On pressure, reset instead of trim-and-summarize.** When the live context crosses the target
(or at a run boundary), rebuild it as:

```
[ system prompt ]  +  [ NOTES.md, re-read as ground truth ]  +
[ recalled memory for the current objective ]  +  [ a short tail of the most recent turns ]
```

— and drop everything else. No summary of the middle, because the middle's value is already in
NOTES. The recent tail preserves the immediate thread; NOTES + memory carry the long arc.

**Guaranteed capture before any reset.** A reset must never race ahead of the notebook. The
consolidation-break checkpoint already forces "write everything durable now" — a reset fires only
after a checkpoint has run, so nothing uncaptured is ever dropped. This is the whole safety
argument, and it is why the autonomy-loop doc gated this on capture being real.

**Compaction becomes the fallback, not the default.** For a session with no durable record (an
interactive chat, no NOTES), lossy compaction is still the only option and stays. For a NOTES-
driven autonomous run, reset-from-NOTES replaces it.

## Why it's safe now (it wasn't before)

The autonomy-loop doc deferred this with a specific condition: *"only safe once the agent reliably
writes everything durable to NOTES.md/work; until then, keep lossy compaction as a fallback."*
That discipline is now demonstrated. Across a ~16-hour unattended run, Zero's NOTES.md grew from
~5 KB to a maintained lab notebook, memory auto-extracted real findings (a live recall returns
"winter.bmp native decompressor is byte-exact," "trace byte2=0xc9 vs native byte2=0"), and the
capture-first prompt held — findings landed on disk the moment they were made, not at run end.
The prerequisite is met. The scratch is genuinely disposable because the record is genuinely kept.

## The second half: don't let a drowning run conclude

Reset-from-NOTES keeps the model in a window it can think in. But the loop should also notice the
drowning *symptom* directly: a run that produces a no-tool-call summary and tries to conclude
while its own NOTES still lists an unfinished NEXT is almost certainly not done — it gave up, it
didn't finish. The loop currently reads any no-tool-call response as "the agent concluded" and
ends the run. For an unbounded run with a live NEXT, that is a premature stop it should catch:
re-orient ("your NEXT is not done — continue, or report if you're actually blocked") rather than
end. This is cheap and directly addresses the failure mode we watched.

## Phases

**Phase 1 — reset at run boundaries.** A working-window target; at the start of each run,
rebuild context from NOTES + memory + a short tail instead of hydrating the full stored history.
Lowest-risk because a run start is *already* a cold prefill — resetting there adds no cache-miss
cost that wasn't going to be paid anyway. This alone would have prevented the drowning: every run
starts lean.

**Phase 2 — reset on mid-run pressure.** When a long run crosses the target mid-flight, checkpoint
and reset in place. Higher cost (a mid-run reset changes the prefix → a cold prefill on a warm
server), so it fires only when the run is long enough that the alternative — drowning — is worse.

**Phase 3 — the no-progress guard.** Detect summarize-and-quit: a concluding response with no tool
call while NOTES' NEXT is unfinished → re-orient instead of ending. Pairs with the existing spiral
and stuck-inference detectors as another "this run stopped for the wrong reason" catch.

**Phase 4 — adaptive target (maybe).** Tune the working-window target from observed engagement:
hold it while the agent is productively using tools, shrink it when it starts summarizing. Harder,
and only worth it once the fixed target proves too blunt.

## Open questions

- **What exactly rebuilds.** How much recent tail (turns? tokens?), NOTES verbatim vs. just its
  Status/NEXT sections, and the memory budget for the recalled block. Too little tail and the
  immediate thread snaps; too much and we're back to accumulation.
- **How the no-progress guard reads "NEXT is unfinished."** The agent self-reporting done vs. a
  heuristic on the NOTES Status/NEXT block. Self-report is cleaner but gameable by a drowning
  model that declares victory.
- **Reset cadence.** Every run start (Phase 1) is simple and cheap. Adding mid-run pressure resets
  (Phase 2) needs a rate limit so a sustained-high context doesn't thrash.
- **The cache-miss.** Any reset changes the prefix and forgoes the warm KV cache. Boundary resets
  are free; mid-run resets are not. This is the main thing that keeps Phase 2 behind Phase 1.
- **Interaction with existing compaction.** Keep compaction strictly as the no-NOTES fallback, or
  eventually retire it for autonomous runs entirely.

## Why this is the priority

Every other core-loop fix this cycle bought reliability — the run no longer dies of a bug. This
one buys *duration*. The manual context knob is the last thing standing between "runs for hours"
and "runs for days without a human watching the window." It is also the honest completion of the
autonomy-loop thesis: an agent that is the human in the loop has to manage its own working memory,
and right now that judgment is still ours.
