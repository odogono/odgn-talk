# A Decision's Verdict is sealed at the end of its first Segment

A Host asks whether something may happen (a game move, a form submit) by sending a Decision: `group.Decide`, `script.Decide` or `group.DecideBroadcast`. These are shaped like `Request`, but their future settles with a Verdict rather than a result. The first `, deciding` Handler Clause the Decision reaches holds its Verdict. The Verdict is sealed at the end of that Run's first Segment. `veto reason` seals it as vetoed and ends the Run, as `return` does. Reaching the first Suspension Point, or ending, seals it as allowed. `pass` hands the open Verdict up the Message Path. A Run that errors, hits a Limit Fault, is cancelled or is stopped before the seal leaves the Decision **undecided**, with that outcome, and the Host chooses what undecided means. The Pump that seals it returns a new `decided` report. For example:

```
on beforeMove m, deciding
  if the to of m is in own then veto "Your own piece is on that square."
  pass beforeMove                   -- let the board have its say
end beforeMove
```

We chose this because ADR 0004's rule, that `veto` comes before the first Suspension Point, already bounds a Verdict to one Segment, and one Segment is bounded by the per-Run Fuel limit. So a Verdict never waits on a Host answer, a timer or another Script, and sealing at the Segment's end needs no deadline of its own. A deciding Run often goes on after the seal (it allows a move, then waits to record it), so the Verdict can't be a `Request` result, which settles only when the Run ends. Reporting failures as undecided keeps the Core from guessing: allowing fails open on a bug, and vetoing makes a crash look like the Script's choice. The [prototype](https://github.com/odogono/odgn-talk/tree/prototype/veto-sketch/prototypes/veto-sketch), with a board game and a sign-up form that veto, is the primary source.

## Considered Options

- **A `Deliver` flag:** a Delivery has no future, so the Host would have to fish the Verdict out of the reports by id.
- **A `Request` variant:** it settles at the Run's end, with a value or `send failed`, so an allowed move would wait for the replay recording that follows it.
- **The Verdict due by the end of the Pump,** with an automatic answer if it isn't ready: a Script behind a Fuel Slice or a mailbox backlog would be answered for, by a rule it can't see.
- **A Host deadline in the Core:** a Host that can't wait already cancels, through its context or signal (`cancel-delivery`, #79).
- **Failures allow, or failures veto:** each is right for some Hosts and dangerous for others. A game refuses the move on a crash, and a form shows "try again".
- **Decisions jump the mailbox:** a Decision would see Script Variables from before messages the Host sent first, such as a `moved` delivered just before the next `beforeMove`.
- **Exempting the first Segment from the Fuel Slice:** it gets the Verdict into the same Pump only when the Decision is already at the head of the mailbox, and it breaks the slice's fairness.
- **`veto` without ending the Run:** it adds a second veto, a veto after the seal and a Run that went on after refusing. No case needed it, since work that must follow a veto can be a `send` to `me` before it.
- **First veto wins across a Broadcast,** with the other recipients cancelled: the form could then show only one of its reasons, and cancelling Runs already in mailboxes gains nothing.
- **Holding the Verdict open in a clause without `, deciding`** until it suspends: that clause can't veto, so this only delays the Host.
- **Inferring decision mode from a `veto` in the body,** with no suffix: a reader couldn't tell a Handler that decides from one that doesn't, and the `pass` rule below would have nothing to attach to.

## Consequences

- **Syntax:** narrows ADR 0019.
  - `, deciding` is a Handler Clause suffix. It combines with `, dropping` or `, replacing`, in either order.
  - `veto` and `veto <expression>` are statements, so `veto` is a Reserved Word. The reason is any value, text in practice, and a bare `veto` gives Nothing.
- **Load errors:** narrows ADR 0004.
  - `veto` outside a `, deciding` Handler, and so in a function, a Lambda, a Library, or a local Handler reached by a Command Call.
  - A `veto` or `pass` in a `, deciding` Handler that some path from the Handler's start reaches through a possible Suspension Point. "Reachable before the first Suspension Point" means that no path crosses one. `pass` needs the rule too, or a parent's veto would come too late.
  - `, queued` with `, deciding`, since a queued Run's Verdict would wait on another Run's Suspension Point.
- **`veto` at run time:**
  - It ends the Run as `completed`, with result Nothing, and `finally` blocks run.
  - In a Run that holds no open Verdict (a Script's plain `send`, or a Host `deliver`), it just ends the Run, and the Trace records a `note`.
  - Scripts can't start Decisions, so there is no Script-to-Script veto.
- **Dispatch:** narrows ADR 0016.
  - A Decision goes through the FIFO mailbox like any Delivery. A suspended Run doesn't block it (ADR 0026), and a preempted Run blocks it until that Segment ends (ADR 0004).
  - A clause without `, deciding` allows at dispatch. If it later passes, the message climbs as an ordinary one.
  - An allow or a veto ends the message, so a parent never sees a Decision a child already decided.
  - Reaching the end of the Message Path allows, and the `unhandled` report is sent as it is today.
  - A `wait for` that takes a Decision allows it at once.
  - `, dropping` settles the new Decision as undecided with outcome `dropped`. `, replacing` only cancels an earlier Run that is already past its seal.
- **Broadcast:**
  - A Broadcast Decision goes to every Script that wants the message, and settles once each recipient has sealed.
  - It is vetoed if any recipient vetoed, undecided if none did but one was undecided, and allowed otherwise. With no recipients, it is allowed.
  - Every veto is reported, in recipient order.
- **Timing:** narrows ADR 0015.
  - A Verdict is reported by the Pump that seals it, which is usually the Pump that drains the Decision. There is no Core deadline and no default answer.
  - A Host that must know now pumps again at the same Clock reading, and each Pump makes progress.
  - Cancelling the context or signal before the seal queues `cancel-delivery`, which settles the Decision as undecided with outcome `cancelled`. Cancelling after the seal does nothing, so Go's usual `defer cancel()` never cancels an allowed Run's follow-up work.
  - Stop Script, disposing the owner and a Reload before the seal settle it as undecided, `cancelled`.
- **Reports:** a `decided` report carries the delivery or broadcast id, the Verdict, every veto as `{script, run, reason}`, and every undecided recipient as `{script, run, outcome}`. The deciding Run still gets its own `run end`.
- **Trace:** narrows ADR 0018.
  - New Host Inputs: `decide` and `decide-broadcast`. A Broadcast Decision's recipients are recorded as a Broadcast's are.
  - A new output record, `decided`, gives the Verdict, then each veto with its reason and each undecided recipient with its outcome.
  - The `seg` end reason gains `veto`.
  - `cancel-delivery` also takes a broadcast id, which cancels every recipient that hasn't sealed.
- **Message layer:** a `decide` message replies with its id, and the `decided` report rides in the `pump` reply. The future stays Host-side, as `Pending` does.
- **Save and restore:** an open Decision is ordinary state (a Delivery in a mailbox, or a Run's frame), so it saves. The Host's future doesn't survive a restore, but the `decided` report still comes with the same id. A variables-only restore that discards the deciding Run settles it as undecided, `cancelled`, at the first Pump.
- **Left for later:** the exact key names of the `decided` record, settled with the final spec, and the Abstract Machine instruction that seals a Verdict (ADR 0010).
