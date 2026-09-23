---------------------------- MODULE TaskRunner ----------------------------
(***************************************************************************)
(* One background task under TaskRunner (src/tasks/runner.ts).             *)
(*                                                                         *)
(* Executions start from tick() (due, active, not already running) or      *)
(* runNow() (API POST /tasks/:id/run, the task_run_now tool). A run may     *)
(* ask its supervisor and get no answer (awaitingInput), in which case it   *)
(* parks the task as "awaiting" when it completes. A human reply on the    *)
(* task's session un-parks an awaiting task. executeTask races the run     *)
(* against a timeout; the run itself only notices the abort at its next    *)
(* checkpoint, so a timed-out execution can still be alive ("zombie").     *)
(*                                                                         *)
(* Fixed = FALSE is the code before the fix, TRUE after it.                *)
(*                                                                         *)
(* Properties:                                                             *)
(*   OneLiveExecution -- never two live executions of one task (they would *)
(*                       share the task:<id> transcript and workspace).    *)
(*   NoLostWakeup     -- the task is never parked while a reply sent after *)
(*                       its ask sits unread with nothing running.         *)
(*   PauseSticks      -- a task the user paused stays paused until resumed. *)
(*                                                                         *)
(* Run: java -cp tla2tools.jar tlc2.TLC -config TaskRunner_<fixed|buggy>.cfg TaskRunner *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Fixed, MaxExecs

Execs == 1..MaxExecs

VARIABLES
  status,      \* task row status
  due,         \* nextRunAt <= now
  es,          \* es[e]: "none" | "run" | "zombie" | "done"
  asked,       \* asked[e]: execution e's ask went unanswered (awaitingInput)
  slot,        \* runningTasks.has(task.id)
  started,     \* executions started so far
  replyUnread, \* a reply arrived after an ask and no run has picked it up yet
  repliedLive, \* fixed: runner noted a reply that landed while the task ran
  userPaused   \* history: the user paused and has not resumed since

vars == <<status, due, es, asked, slot, started, replyUnread, repliedLive, userPaused>>

Live == {e \in Execs : es[e] \in {"run", "zombie"}}

Init ==
  /\ status = "active"
  /\ due = TRUE
  /\ es = [e \in Execs |-> "none"]
  /\ asked = [e \in Execs |-> FALSE]
  /\ slot = FALSE
  /\ started = 0
  /\ replyUnread = FALSE
  /\ repliedLive = FALSE
  /\ userPaused = FALSE

\* executeTask: register in runningTasks, start doExecute. A fresh AgentLoop
\* hydrates the task transcript, so any unread reply is now seen.
Start ==
  /\ started < MaxExecs
  /\ LET e == started + 1 IN
     /\ es' = [es EXCEPT ![e] = "run"]
     /\ started' = e
  /\ slot' = TRUE
  /\ replyUnread' = FALSE
  /\ repliedLive' = FALSE
  /\ UNCHANGED <<status, due, asked, userPaused>>

Tick == status = "active" /\ due /\ ~slot /\ Start

\* runNow ignores status and schedule by design; before the fix it also
\* ignored whether the task was already running.
RunNow == (Fixed => ~slot) /\ Start

AskUnanswered(e) ==
  /\ es[e] = "run"
  /\ ~asked[e]
  /\ asked' = [asked EXCEPT ![e] = TRUE]
  /\ UNCHANGED <<status, due, es, slot, started, replyUnread, repliedLive, userPaused>>

\* POST /chat on task:<id>. resumeParkedTask only looks at status; the fix
\* also tells the runner when the reply lands while the task is running.
Reply ==
  /\ \E e \in Execs : asked[e]
  /\ IF status = "awaiting"
       THEN /\ status' = "active" /\ due' = TRUE
            /\ UNCHANGED <<replyUnread, repliedLive>>
       ELSE /\ replyUnread' = TRUE
            /\ repliedLive' = ((Fixed /\ slot) \/ repliedLive)
            /\ UNCHANGED <<status, due>>
  /\ UNCHANGED <<es, asked, slot, started, userPaused>>

\* The success path of executeTask for a run that finished in time.
Finish(e) ==
  /\ es[e] = "run"
  /\ es' = [es EXCEPT ![e] = "done"]
  /\ IF asked[e]
       THEN IF Fixed
              THEN IF repliedLive
                     THEN due' = TRUE /\ UNCHANGED status      \* answered already: run again
                     ELSE /\ status' = IF status = "active" THEN "awaiting" ELSE status
                          /\ UNCHANGED due
              ELSE status' = "awaiting" /\ UNCHANGED due        \* unconditional park
       ELSE due' = FALSE /\ UNCHANGED status                    \* rescheduled
  \* finally: runningTasks.delete(task.id) -- whoever's entry it is
  /\ slot' = IF Fixed THEN Live \ {e} # {} ELSE FALSE
  /\ UNCHANGED <<asked, started, replyUnread, repliedLive, userPaused>>

\* The race's timeout wins: failure path, finally frees the slot. The
\* execution is aborted but still alive until it reaches a checkpoint.
Timeout(e) ==
  /\ es[e] = "run"
  /\ es' = [es EXCEPT ![e] = "zombie"]
  /\ due' = FALSE
  /\ slot' = IF Fixed THEN TRUE ELSE FALSE
  /\ UNCHANGED <<status, asked, started, replyUnread, repliedLive, userPaused>>

ZombieEnds(e) ==
  /\ es[e] = "zombie"
  /\ es' = [es EXCEPT ![e] = "done"]
  /\ slot' = IF Fixed THEN Live \ {e} # {} ELSE slot
  /\ UNCHANGED <<status, due, asked, started, replyUnread, repliedLive, userPaused>>

Clock == ~due /\ due' = TRUE /\ UNCHANGED <<status, es, asked, slot, started, replyUnread, repliedLive, userPaused>>

Pause ==
  /\ status \in {"active", "awaiting"}
  /\ status' = "paused"
  /\ userPaused' = TRUE
  /\ UNCHANGED <<due, es, asked, slot, started, replyUnread, repliedLive>>

Resume ==
  /\ status = "paused"
  /\ status' = "active"
  /\ userPaused' = FALSE
  /\ UNCHANGED <<due, es, asked, slot, started, replyUnread, repliedLive>>

Next ==
  \/ Tick \/ RunNow \/ Reply \/ Clock \/ Pause \/ Resume
  \/ \E e \in Execs : AskUnanswered(e) \/ Finish(e) \/ Timeout(e) \/ ZombieEnds(e)

Spec == Init /\ [][Next]_vars

OneLiveExecution == Cardinality(Live) <= 1

NoLostWakeup == ~(status = "awaiting" /\ replyUnread /\ Live = {})

PauseSticks == userPaused => status = "paused"
=============================================================================
