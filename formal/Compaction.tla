---------------------------- MODULE Compaction ----------------------------
(***************************************************************************)
(* CompactionScheduler (src/agent/compaction.ts) and the summary it keeps. *)
(*                                                                         *)
(* schedule() chains a summarization job onto `pending`; each job reads    *)
(* the context's summary when it starts and writes the new one (to the     *)
(* context and to the sessions row) when it ends. drain() awaits `pending` *)
(* and then clears it. reset() (clearContext / resetSession) swaps in a    *)
(* fresh context and drops the chain without awaiting it. drain() can      *)
(* overlap schedule(): run() drains at its start while POST                *)
(* /sessions/:id/compact (compactNow: drain, then schedule) is not queued  *)
(* behind the session's run.                                               *)
(*                                                                         *)
(* Fixed = FALSE is the code before the fix, TRUE after it.                *)
(*                                                                         *)
(* Properties:                                                             *)
(*   NoLostSummary   -- every finished job of the live context is folded   *)
(*                      into its summary (two jobs never read the same     *)
(*                      base and overwrite each other).                    *)
(*   NoResurrection  -- after a reset, the stored summary never comes back *)
(*                      from a job that belonged to the old context.       *)
(*                                                                         *)
(* Run: java -cp tla2tools.jar tlc2.TLC -config Compaction_<fixed|buggy>.cfg Compaction *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS Fixed, MaxJobs, MaxResets

Jobs == 1..MaxJobs

VARIABLES
  epoch,    \* which context is live (bumped by reset)
  tail,     \* job `pending` currently ends with, 0 when null
  js,       \* js[j]: "none" | "queued" | "running" | "done"
  prev,     \* prev[j]: job j was chained behind, 0 for none
  ep,       \* ep[j]: context job j was scheduled for
  read,     \* read[j]: jobs folded into the summary job j started from
  folded,   \* jobs folded into the live context's summary
  nJobs,
  dcap,     \* drain in progress: the `pending` it is awaiting, -1 if none
  rowLive,  \* the sessions row exists (reset deletes it; the next message recreates it)
  stored    \* context the stored summary came from, -1 if none

vars == <<epoch, tail, js, prev, ep, read, folded, nJobs, dcap, rowLive, stored>>

Init ==
  /\ epoch = 0
  /\ tail = 0
  /\ js = [j \in Jobs |-> "none"]
  /\ prev = [j \in Jobs |-> 0]
  /\ ep = [j \in Jobs |-> 0]
  /\ read = [j \in Jobs |-> {}]
  /\ folded = {}
  /\ nJobs = 0
  /\ dcap = -1
  /\ rowLive = TRUE
  /\ stored = -1

Schedule ==
  /\ nJobs < MaxJobs
  /\ LET j == nJobs + 1 IN
     /\ js' = [js EXCEPT ![j] = "queued"]
     /\ prev' = [prev EXCEPT ![j] = tail]
     /\ ep' = [ep EXCEPT ![j] = epoch]
     /\ tail' = j
     /\ nJobs' = j
  /\ UNCHANGED <<epoch, read, folded, dcap, rowLive, stored>>

\* A chained step starts once its predecessor settled: existingSummary is
\* read here. Jobs of a dead context read the dead context; not tracked.
JobStart(j) ==
  /\ js[j] = "queued"
  /\ IF prev[j] = 0 THEN TRUE ELSE js[prev[j]] = "done"
  /\ js' = [js EXCEPT ![j] = "running"]
  /\ read' = [read EXCEPT ![j] = IF ep[j] = epoch THEN folded ELSE {}]
  /\ UNCHANGED <<epoch, tail, prev, ep, folded, nJobs, dcap, rowLive, stored>>

\* onSummary + conversationStore.updateSummary. The fix drops the result of
\* a job whose context was reset while it ran.
JobEnd(j) ==
  /\ js[j] = "running"
  /\ js' = [js EXCEPT ![j] = "done"]
  /\ folded' = IF ep[j] = epoch THEN read[j] \cup {j} ELSE folded
  /\ stored' = IF rowLive /\ (Fixed => ep[j] = epoch) THEN ep[j] ELSE stored
  /\ UNCHANGED <<epoch, tail, prev, ep, read, nJobs, dcap, rowLive>>

DrainBegin ==
  /\ dcap = -1
  /\ tail # 0
  /\ dcap' = tail
  /\ UNCHANGED <<epoch, tail, js, prev, ep, read, folded, nJobs, rowLive, stored>>

\* `await this.pending; this.pending = null` -- the fix only clears it when
\* nothing was chained on while it waited.
DrainEnd ==
  /\ dcap # -1
  /\ js[dcap] = "done"
  /\ tail' = IF Fixed /\ tail # dcap THEN tail ELSE 0
  /\ dcap' = -1
  /\ UNCHANGED <<epoch, js, prev, ep, read, folded, nJobs, rowLive, stored>>

Reset ==
  /\ epoch < MaxResets
  /\ epoch' = epoch + 1
  /\ tail' = 0
  /\ folded' = {}
  /\ rowLive' = FALSE
  /\ stored' = -1
  /\ UNCHANGED <<js, prev, ep, read, nJobs, dcap>>

\* The next persisted message recreates the sessions row.
Append ==
  /\ ~rowLive
  /\ rowLive' = TRUE
  /\ UNCHANGED <<epoch, tail, js, prev, ep, read, folded, nJobs, dcap, stored>>

Next ==
  \/ Schedule \/ DrainBegin \/ DrainEnd \/ Reset \/ Append
  \/ \E j \in Jobs : JobStart(j) \/ JobEnd(j)

Spec == Init /\ [][Next]_vars

NoLostSummary == \A j \in Jobs : (js[j] = "done" /\ ep[j] = epoch) => j \in folded

NoResurrection == stored \in {-1, epoch}
=============================================================================
