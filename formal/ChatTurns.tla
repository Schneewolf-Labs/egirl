---------------------------- MODULE ChatTurns ----------------------------
(***************************************************************************)
(* How an inbound chat message becomes an agent run, per transport.        *)
(*                                                                         *)
(* One AgentLoop (one session) behind one chat surface. The user sends     *)
(* messages; each either answers a parked `report` ask through the         *)
(* ReplyBroker or starts a run on the loop. A run may park on an ask, which *)
(* resolves on the next inbound message or on its timeout.                 *)
(*                                                                         *)
(* Mode models the dispatch discipline:                                    *)
(*   "concurrent" -- Telegram / Matrix / XMPP before the fix: every        *)
(*                   message is dispatched at once, not awaited.           *)
(*   "discord"    -- Discord before the fix: the broker check happens on   *)
(*                   arrival, then one FIFO queue in front of runTurn, plus *)
(*                   the slash-command fast path, which skips the queue    *)
(*                   even when a custom command expands into a turn.       *)
(*   "fixed"      -- broker check first, then runs serialized per loop     *)
(*                   (AgentLoop.run chains behind the previous run).       *)
(*                                                                         *)
(* Properties:                                                             *)
(*   OneRunPerLoop -- two runs never interleave turns in one context       *)
(*                    (activeRun, pendingInjections, history watermarks    *)
(*                    all assume this).                                    *)
(*   NoLostAnswer  -- an ask never times out while a message the user sent *)
(*                    after it was parked is still waiting to be handled.  *)
(*                                                                         *)
(* Before the fix NoLostAnswer holds everywhere and OneRunPerLoop fails in *)
(* "concurrent" and "discord". NoLostAnswer is the constraint on the fix:  *)
(* serializing in front of the broker check (awaiting each turn in the     *)
(* transport) would park the answer behind the run that is waiting for it. *)
(*                                                                         *)
(* Run: java -cp tla2tools.jar tlc2.TLC -config ChatTurns_<mode>.cfg ChatTurns *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Mode, MaxMsgs, MaxAsks

ASSUME Mode \in {"concurrent", "discord", "fixed"}

Msgs == 1..MaxMsgs

VARIABLES
  sent,      \* messages sent so far
  rs,        \* rs[i]: fate of message i
  whileAsk,  \* whileAsk[i]: message i was sent while an ask was parked
  parked,    \* run id holding the broker's pending ask, 0 if none
  asks,      \* asks issued so far (bounds the model)
  tq,        \* discord: transport queue of message ids
  qBusy,     \* discord: run the queue drainer is awaiting, 0 if none
  lq,        \* fixed: runs waiting on the loop's run chain
  lost       \* an ask timed out with an answer stuck behind it

vars == <<sent, rs, whileAsk, parked, asks, tq, qBusy, lq, lost>>

\* "idle": not sent yet   "wire": waiting in a transport or run queue
\* "work": run executing  "asking": run parked on an ask
\* "answer": consumed as the answer to an ask   "done": run finished
Active == {i \in Msgs : rs[i] \in {"work", "asking"}}

Init ==
  /\ sent = 0
  /\ rs = [i \in Msgs |-> "idle"]
  /\ whileAsk = [i \in Msgs |-> FALSE]
  /\ parked = 0
  /\ asks = 0
  /\ tq = <<>>
  /\ qBusy = 0
  /\ lq = <<>>
  /\ lost = FALSE

\* ReplyBroker.tryDeliver: consume message i as the answer to the parked ask.
Answer(i) ==
  /\ rs' = [rs EXCEPT ![i] = "answer", ![parked] = "work"]
  /\ parked' = 0

\* runTurn on a message that is not an answer: start the run immediately.
StartNow(i) == rs' = [rs EXCEPT ![i] = "work"] /\ UNCHANGED parked

\* The user types a message (not a slash command).
Send ==
  /\ sent < MaxMsgs
  /\ LET i == sent + 1 IN
     /\ sent' = i
     /\ whileAsk' = [whileAsk EXCEPT ![i] = (parked # 0)]
     /\ CASE Mode = "concurrent" ->
               /\ IF parked # 0 THEN Answer(i) ELSE StartNow(i)
               /\ UNCHANGED <<tq, lq>>
          [] Mode = "discord" ->
               /\ IF parked # 0
                    THEN Answer(i) /\ UNCHANGED tq
                    ELSE rs' = [rs EXCEPT ![i] = "wire"] /\ tq' = Append(tq, i)
                         /\ UNCHANGED parked
               /\ UNCHANGED lq
          [] Mode = "fixed" ->
               /\ IF parked # 0
                    THEN Answer(i) /\ UNCHANGED lq
                    ELSE rs' = [rs EXCEPT ![i] = "wire"] /\ lq' = Append(lq, i)
                         /\ UNCHANGED parked
               /\ UNCHANGED tq
  /\ UNCHANGED <<asks, qBusy, lost>>

\* Discord only: a custom slash command that expands into a turn. isCommand()
\* sends it around the queue, straight into runTurn.
SendCommandTurn ==
  /\ Mode = "discord"
  /\ sent < MaxMsgs
  /\ LET i == sent + 1 IN
     /\ sent' = i
     /\ whileAsk' = [whileAsk EXCEPT ![i] = (parked # 0)]
     /\ StartNow(i)
  /\ UNCHANGED <<asks, tq, qBusy, lq, lost>>

\* Discord's drainQueue: take the head once the previous task has settled.
DiscordDrain ==
  /\ Mode = "discord"
  /\ qBusy = 0
  /\ tq # <<>>
  /\ LET i == Head(tq) IN
     /\ tq' = Tail(tq)
     /\ IF parked # 0
          THEN Answer(i) /\ UNCHANGED qBusy
          ELSE StartNow(i) /\ qBusy' = i
  /\ UNCHANGED <<sent, whileAsk, asks, lq, lost>>

\* Fixed: the loop's run chain starts the next run once none is active.
ChainStart ==
  /\ Mode = "fixed"
  /\ Active = {}
  /\ lq # <<>>
  /\ rs' = [rs EXCEPT ![Head(lq)] = "work"]
  /\ lq' = Tail(lq)
  /\ UNCHANGED <<sent, whileAsk, parked, asks, tq, qBusy, lost>>

\* A run calls report(mode=ask) and parks on the broker.
Ask(r) ==
  /\ rs[r] = "work"
  /\ parked = 0
  /\ asks < MaxAsks
  /\ rs' = [rs EXCEPT ![r] = "asking"]
  /\ parked' = r
  /\ asks' = asks + 1
  /\ UNCHANGED <<sent, whileAsk, tq, qBusy, lq, lost>>

\* The ask's timer fires. If the user already answered but the answer is
\* stuck in a queue, the answer is lost: the ask resolves undefined and the
\* answer later runs as an unrelated new turn.
AskTimeout ==
  /\ parked # 0
  /\ rs' = [rs EXCEPT ![parked] = "work"]
  /\ parked' = 0
  /\ lost' = (lost \/ \E i \in Msgs : whileAsk[i] /\ rs[i] = "wire")
  /\ UNCHANGED <<sent, whileAsk, asks, tq, qBusy, lq>>

Finish(r) ==
  /\ rs[r] = "work"
  /\ rs' = [rs EXCEPT ![r] = "done"]
  /\ qBusy' = IF qBusy = r THEN 0 ELSE qBusy
  /\ UNCHANGED <<sent, whileAsk, parked, asks, tq, lq, lost>>

\* drainQueue runs synchronously on enqueue and right after each task settles,
\* so nothing else can happen while an idle drainer has work in its queue.
Settled == ~(Mode = "discord" /\ qBusy = 0 /\ tq # <<>>)

Next ==
  \/ DiscordDrain
  \/ /\ Settled
     /\ \/ Send
        \/ SendCommandTurn
        \/ ChainStart
        \/ AskTimeout
        \/ \E r \in Msgs : Ask(r) \/ Finish(r)

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ sent \in 0..MaxMsgs
  /\ rs \in [Msgs -> {"idle", "wire", "work", "asking", "answer", "done"}]
  /\ parked \in 0..MaxMsgs
  /\ qBusy \in 0..MaxMsgs

OneRunPerLoop == Cardinality(Active) <= 1

NoLostAnswer == ~lost
=============================================================================
