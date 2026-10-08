# A Run in its first Segment can be rewound to its Delivery

A Host may **Rewind** a Run that hasn't yet passed a Suspension Point. The Core rolls back its Segment as a Limit Fault would, ends the Run with no `catch` or `finally`, and puts its message back at the head of its Script's mailbox with its delivery and reply ids and its Message Path position. So the next dispatch of that message is the Run starting again. Reload gains an option to keep the mailbox, and the debugger's **Fix and Continue** is a Rewind of the paused Run followed by a Reload that keeps the mailbox, so the same message runs on the edited code. We chose this because today fixing a bug found mid-Run is stop-and-reload, which throws the Run and its setup away. Smalltalk's "edit the method in the debugger, restart the frame" is the workflow we want, and a Run in its first Segment needs nothing the Core doesn't already keep. Its rollback base is the Segment base Limit Faults use (ADR 0006), and its start is the dispatch of a message, which is "the Run's first code" (ADR 0010). It stays inside ADR 0014's rule: no Run ever runs on code other than what it started on, since the rewound Run no longer exists. Settled in #332.

- **First Segment only.** A Run that has passed a Suspension Point can't be rewound: the Host error is `not rewindable`, as for a Run that has ended. Its earlier Segments are committed, and a Segment base holds no frame to resume from.
- **Any message.** Host Deliveries, Requests (whose asker keeps waiting on the same reply id), Broadcast and Decision Deliveries (a Decision's Verdict is sealed only at the end of its first Segment, ADR 0031), Function Value calls, `error` messages, climbed messages and Runs parked by `, queued` all go back as they left the mailbox.
- **Effects stay done.** Rewind undoes what a Limit Fault undoes: Script Variables, and the Segment-bound participant (ADR 0048), including Store writes (ADR 0050). It abandons pending calls and live scopes. Immediate and fire-and-forget Capability calls and messages sent are final, and happen again on redispatch. Tooling shows the developer which ones; the Core refuses nothing for them.
- **Fuel stays charged.** The rolled-back Segment's Fuel isn't refunded, and dispatch is charged again, as rollback, Stop and Reload "retain already charged work".

## Considered Options

- **Rewind any Segment, resuming at its Suspension Point in the new code,** by source position or by the `wait`'s index in its Handler. Every resume would need a frame snapshot, and mapping a frame onto new code is the migration ADR 0008 rejected as unbounded and fragile.
- **Rewind any Segment to its Handler's start.** Earlier Segments' changes and effects are committed, so they would happen twice, and Script Variables would no longer match what the restarted Handler expects.
- **A rolled-back Run that waits to be rerun.** A new Run state for the Core to hold, save and report, where putting its message back gives the same result with none.
- **Rewind carrying the new source, swapping code inside the Pump.** It would make a Reload a mid-Pump step; keeping Reload a worker call between Pumps leaves the Rewind as the only new mid-Pump behaviour.
- **Refusing when the Segment made effects a rollback can't undo.** Nearly every real Handler calls a Capability, so it would refuse almost always, and the Trace records the repeat, so replay stays exact.
- **Keeping old Runs on old code** (Erlang-style two versions), rejected by ADR 0014.

## Consequences

- **Embedding:** `Run.Rewind(run)` is a Host Input. While a Pump is in flight it lands at an instruction boundary, and the Pump returns at once with a new outcome, `rewound`, so the Host can Reload before anything redispatches the message on the old code. Between Pumps it rewinds a preempted Run.
- **Trace:** a `rewind` record carries `run` and, when it lands mid-Pump, `fuel`, the Fuel used in the Pump so far. Fuel is charged per instruction and is bit-for-bit across the Cores (ADR 0009), so replay runs the Pump to that count and applies it there. A `pc` alone would be ambiguous inside a loop. The `reload` record gains the mailbox option.
- **Reload:** with the mailbox kept, the Script's other Runs are still discarded with no `finally` and reported, and the senders of kept messages go on waiting. Variables carry by Reload's usual rules: no frame survives, so a change to the Script Variables' shape is safe.
- **Debugger:** "no edits" becomes: the debugger never writes Script state, changing code is a Reload, and Fix and Continue is a Rewind then a Reload. Rewind is the one worker call accepted while paused, and it ends the pause. Pauses stay outside the Trace.
- **Run accounting** (ADR 0065): the rewound Run is reported as `run discarded`, with a new reason, `rewind`, and its Fuel captured before it goes. The redispatch starts a new Run with a new run id under the same root Delivery, so the root's causal work counts both.
- **Saves:** no new rule. After a Rewind the Run holds no Live Host Effects (ADR 0049), and the message is ordinary mailbox state.
- **Scope:** both Cores implement it for parity and replay, but only the Session Host and debugger need to expose it.
