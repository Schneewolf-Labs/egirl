--------------------------- MODULE SessionMutex ---------------------------
(***************************************************************************)
(* SessionMutex (src/agent/session-mutex.ts) and the one tool that awaits  *)
(* another agent run from inside its tool phase: task_run_now.             *)
(*                                                                         *)
(* The mutex is modelled as written: `locked`, a FIFO of waiters, release  *)
(* handing the lock straight to the head waiter, and a per-waiter acquire  *)
(* timeout that splices the waiter out and rejects it. JS is single-       *)
(* threaded, so each method body is one atomic step.                       *)
(*                                                                         *)
(* Processes:                                                              *)
(*   "caller" -- a run whose tool phase (held under the mutex) calls        *)
(*               task_run_now.                                             *)
(*   "task"   -- the task run that starts; its tool phase needs the mutex. *)
(*   "other"  -- an unrelated run on another channel.                      *)
(*                                                                         *)
(* Fixed = FALSE: task_run_now awaits runner.runNow() inside the tool.     *)
(* Fixed = TRUE:  it starts the run and returns, releasing the mutex.      *)
(*                                                                         *)
(* Properties:                                                             *)
(*   MutualExclusion -- at most one holder, under every interleaving of    *)
(*                      acquire, release and waiter timeouts (holds in     *)
(*                      both modes: the mutex itself is correct).          *)
(*   NoAcquireTimeout -- no run fails for want of the lock. Before the fix *)
(*                      the task run can only ever get it by timing out:   *)
(*                      its caller holds the lock until it finishes.       *)
(*                                                                         *)
(* Run: java -cp tla2tools.jar tlc2.TLC -config SessionMutex_<fixed|buggy>.cfg SessionMutex *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANT Fixed

Procs == {"caller", "task", "other"}

VARIABLES locked, waiters, pc

vars == <<locked, waiters, pc>>

\* "idle" -> "waiting" -> "held" -> "done" | "failed"
\* "caller" additionally passes through "awaitTask" while holding.
\* "task" starts at "off" until task_run_now starts it.
Holding == {p \in Procs : pc[p] \in {"held", "awaitTask"}}

Init ==
  /\ locked = FALSE
  /\ waiters = <<>>
  /\ pc = [p \in Procs |-> IF p = "task" THEN "off" ELSE "idle"]

Acquire(p) ==
  /\ pc[p] = "idle"
  /\ IF ~locked
       THEN locked' = TRUE /\ pc' = [pc EXCEPT ![p] = "held"] /\ UNCHANGED waiters
       ELSE waiters' = Append(waiters, p) /\ pc' = [pc EXCEPT ![p] = "waiting"]
            /\ UNCHANGED locked

\* release(): hand the lock to the head waiter, or unlock.
ReleaseFrom(p, next) ==
  IF waiters # <<>>
    THEN /\ pc' = [next EXCEPT ![p] = "done", ![Head(waiters)] = "held"]
         /\ waiters' = Tail(waiters)
         /\ UNCHANGED locked
    ELSE /\ pc' = [next EXCEPT ![p] = "done"]
         /\ locked' = FALSE
         /\ UNCHANGED waiters

\* The waiter's timer: splice it out and reject.
WaitTimeout(p) ==
  /\ pc[p] = "waiting"
  /\ waiters' = SelectSeq(waiters, LAMBDA q : q # p)
  /\ pc' = [pc EXCEPT ![p] = "failed"]
  /\ UNCHANGED locked

\* The caller's tool phase runs task_run_now.
CallRunNow ==
  /\ pc["caller"] = "held"
  /\ pc["task"] = "off"
  /\ IF Fixed
       THEN ReleaseFrom("caller", [pc EXCEPT !["task"] = "idle"])
       ELSE pc' = [pc EXCEPT !["caller"] = "awaitTask", !["task"] = "idle"]
            /\ UNCHANGED <<locked, waiters>>

\* runNow resolves once the task run ends, however it ended.
CallerResumes ==
  /\ pc["caller"] = "awaitTask"
  /\ pc["task"] \in {"done", "failed"}
  /\ ReleaseFrom("caller", pc)

Finish(p) ==
  /\ p # "caller"
  /\ pc[p] = "held"
  /\ ReleaseFrom(p, pc)

Terminated == \A p \in Procs : pc[p] \in {"done", "failed"}

Progress ==
  \/ CallRunNow
  \/ CallerResumes
  \/ \E p \in Procs : Acquire(p) \/ Finish(p)

\* The acquire timeout is ten minutes: it only decides the outcome when the
\* system is otherwise stuck, i.e. when nothing else can make progress.
Next ==
  \/ Progress
  \/ ~ENABLED Progress /\ \E p \in Procs : WaitTimeout(p)
  \/ Terminated /\ UNCHANGED vars

Spec == Init /\ [][Next]_vars

MutualExclusion == Cardinality(Holding) <= 1

\* locked is true exactly when someone holds the lock, and only waiting
\* processes are queued -- the mutex's own representation invariant.
LockConsistent ==
  /\ locked <=> Holding # {}
  /\ \A i \in 1..Len(waiters) : pc[waiters[i]] = "waiting"

NoAcquireTimeout == \A p \in Procs : pc[p] # "failed"
=============================================================================
