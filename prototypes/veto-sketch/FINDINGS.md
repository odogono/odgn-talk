# Findings: decisions and vetoes (#80)

`veto.html` runs two Hosts that actually veto: a board game (piece Scripts and a board Script refuse moves) and a sign-up form (field validators refuse a submit). Every walkthrough was also run headless against the same model. These are the answers it gave.

## The rule that held up

**A verdict is sealed at the end of the first Segment of the Run that holds it.** That Run is the first `, deciding` Handler Clause the Decision reaches. `veto` seals it as vetoed. Reaching the first Suspension Point, or ending, seals it as allowed. `pass` hands the open verdict up the Message Path. A Run that errors, faults, is cancelled or is stopped before the seal leaves the Decision **undecided**, with that outcome, and the Host picks what undecided means.

ADR 0004's load-time rule is what makes this cheap. Because `veto` can only be reached before the first Suspension Point, the seal always comes within one Segment, and one Segment is bounded by the per-Run Fuel limit. So a verdict never waits on a Host answer, a timer or another Script.

## The Host call

- **Its own call, not a variant.** A Deliver has no future. A Request settles when the Run *ends*, with a value or `send failed`, but a deciding Run often goes on after the seal: the board allows the move, then waits to record it for the replay ("Passed up, then allowed"). The verdict has to arrive before the Run ends, and it isn't a result value. So there is `group.Decide(ctx, to, m)`, `script.Decide(ctx, m)` and `group.DecideBroadcast(ctx, m)`, shaped like Request, whose future settles with a `Decided`.
- **The report.** A new `decided` report carries the delivery or broadcast id, the verdict (`allowed`, `vetoed` or `undecided`), every veto as `{script, run, reason}`, and every undecided recipient as `{script, run, outcome}`. The deciding Run still gets its own `run end`, later if it went on after the seal.
- **`veto` ends the Run,** as `return` does: `finally` blocks run and the outcome is `completed`. The reason is any value, text in practice, and `veto` alone gives Nothing. There was never a case for vetoing and carrying on. Work that must follow a veto can be a `send` to `me` before it.

## Timing

- **Due at the seal, reported by the Pump that seals it.** Usually that is the Pump that drains the Decision. There is no Core deadline and no default answer.
- **Several Pumps when the Script is busy.** "A slow answer" pumps a board mid-way through 40 Fuel of work with a 10-Fuel slice: the verdict comes back in the fifth Pump. A game that must know this tick pumps again at the same Clock reading, which ADR 0015 already allows. Each Pump makes progress, so this always ends.
- **A Host deadline is a cancel.** Cancelling the context or signal queues `cancel-delivery` (#79). A Decision still in the mailbox is removed, and one being decided cancels its Run. Either way it settles as undecided with outcome `cancelled` ("The Host can't wait").
- **Cancelling after the verdict does nothing.** The rest of the Run belongs to the Script. Otherwise Go's usual `defer cancel()` would cancel every allowed Run's follow-up work.
- **Failures are undecided, never guessed.** The bishop's Handler raises `no such key` before deciding ("A buggy decider"). Allowing would fail open on a bug, and vetoing would let a crash look like a Script's choice. The Core reports the outcome, and the Host chooses. A game refuses the move, and a form shows "try again".
- **Stop, dispose and reload** before the seal leave it undecided (`cancelled`), as "Stopped mid-decision" shows.

## A busy Script

- **A suspended Run doesn't block a Decision.** Handler Clauses run concurrently by default (ADR 0026), so in "A busy board" a Decision is dispatched while the `pause` Run is suspended on a 30-second timer. It sees `frozen` as true and vetoes at once.
- **A preempted Run does block it,** for the rest of that Run's Segment, as ADR 0004 already requires (time-slicing isn't a Suspension Point).
- **No jumping the mailbox.** A Decision waits its turn in the FIFO mailbox. Jumping would let a Decision see Script Variables from before messages the Host sent first, such as a `moved` delivered just before the next `beforeMove`. The backlog is bounded, so the Host pumps through it.
- **No automatic allow or deny.** The Core never answers for a Script. The Host already has a deadline (cancel) and a policy for undecided.
- **`, queued` with `, deciding` is a load error.** A queued Run parks behind the clause's suspended Run, so its verdict would wait on someone else's wait, which is exactly what ADR 0004's rule exists to prevent.
- **`, dropping` with `, deciding`** settles the new Decision as undecided with outcome `dropped`: the Script had a say and chose not to give it. **`, replacing`** only ever cancels an earlier Run that is already past its seal, so no verdict changes.

## Many deciders

- **Along the Message Path, the first `, deciding` clause decides.** A veto ends the message, so a parent never sees a Decision a child vetoed ("The knight refuses"). An allow ends it too, since a message stops once it's handled. A child that wants the parent to have a say passes: the knight vetoes only its own squares and passes the rest to the board ("Passed up, then allowed").
- **A clause without `, deciding` allows at dispatch.** It can't veto, so there is nothing to wait for. If it later passes, the message climbs as an ordinary one, with no verdict. The prototype first held the verdict open until such a clause suspended, which only delayed the Host for nothing.
- **The end of the path allows,** and the `unhandled` report is sent as today.
- **A Broadcast Decision asks every Script that wants the message,** and settles once each recipient has sealed. It is vetoed if any recipient vetoed, undecided if none did but one was undecided, and allowed otherwise. Every veto is reported, in recipient order, so the form shows both "Enter a real email address" and "Use at least 8 characters" at once ("The sign-up form"). First-veto-wins with the others cancelled would have dropped the second reason, and cancelling Runs already in mailboxes gains nothing. A recipient without `, deciding` (analytics) allows at dispatch. With no recipients it is allowed.
- **A `wait for` that takes a Decision** allows at once, because a waiting Run can't veto.

## Syntax

- **`, deciding`** is a Handler Clause suffix, as ADR 0019 already reserves. It combines with `, dropping` or `, replacing`, in either order, and never with `, queued`.
- **`veto [expression]`** is a statement, so `veto` becomes a Reserved Word (ADR 0019: every statement keyword is reserved).
- **Load errors** (from the prototype's checker):
  - `veto` outside a `, deciding` Handler, including in a function, a Lambda, a Library, or a local Handler reached by a Command Call.
  - A `veto` or `pass` in a `, deciding` Handler that some path from the Handler's start reaches through a possible Suspension Point. ADR 0004 says "reachable before the first Suspension Point", which reads as "some path". It has to be "no path crosses one", or the verdict could already be sealed when the `veto` runs. `pass` needs the same rule, or a parent's veto would come too late.
  - `, queued` with `, deciding`.
- **A `veto` in a Run that holds no open verdict** (a Script's plain `send`, or a Host `deliver`) just ends the Run, with a Trace `note`. Scripts can't start Decisions, so there is no Script-to-Script veto in v1.
- The tour's handler shape was right: `on beforeMove m, deciding` / `if … then veto "…"` / `pass beforeMove`.

## Parity and the message layer

- **Trace (ADR 0018):**
  - New Host Inputs: `> decide <delivery> <target> <message> <args>` and `> decide-broadcast <broadcast> <message> <args>`, with the recipients recorded as a Broadcast's are.
  - A new output record: `decided <id> <verdict>`, followed by each veto (`<run> reason=…`) and each undecided recipient (`<run> outcome=…`).
  - The `seg` end reason gains `veto`.
  - `cancel-delivery` covers Decisions, and takes a broadcast id for a Broadcast Decision.
- **Message layer (#73):** a `decide` message (`to` or `script`, `message`, optional `broadcast: true`) replies with its id. The `decided` report rides in the `pump` reply like any other report. The future stays Host-side, as `Pending` does.
- **Save and restore:** an open Decision is ordinary state (a Delivery in a mailbox or a Run's frame), so it saves. The Host's future doesn't survive a restore, but the `decided` report still comes with the same id. A variables-only restore that discards the deciding Run settles it as undecided, `cancelled`, at the first Pump.

## Left out of the prototype

Guards, Segment rollback, Allocation Budgets, Joins, `wait for`, `, dropping`, `, replacing`, dispose, reload and save aren't modelled: the answers above for them are reasoned from the rule, not clicked through. None of them change when a verdict seals: Guards and dispatch never suspend, and a Join's `end wait` is just a Suspension Point.
