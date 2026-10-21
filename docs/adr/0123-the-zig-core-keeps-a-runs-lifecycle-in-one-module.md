# The Zig Core keeps a Run's lifecycle in one module

A Run's lifecycle in the Zig Core was spread across about ten functions in `machine.zig`:
- Three copies of the loop that removes a Run from its Script's live Runs and work.
- Four copies of the fault for a refused Charge.
- Four places that reset a Stretch.
- The Run's state was never stored. It was inferred from the `parked`, `continuing`, `crossed`, `ending` and `resume_with` flags.

#1068 needed a fix in each fault path, and these same paths had to be fixed again later. ADR 0105 found the same problem with Waits: "every new way for a Run to end had to remember each of these". The Zig Core now keeps a Run's lifecycle in one module, `run_lifecycle.zig`, next to the Wait table ([#1451](https://github.com/odogono/odgn-talk/issues/1451)).

The module owns:

- the Run's state between turns, stored explicitly: running, preempted, paused at a crossing, suspended or parked. It replaces the `parked`, `continuing` and `crossed` flags. Two things stay beside it, because they overlap any state. One is what a ready Run resumes with: a Join's end makes its Run ready before its Segment ends. The other is a Segment end in progress: it can pause at a lifecycle crossing in any state;
- the Run's place in its Script's live Runs and work: detaching it, putting it back at the head of the work, and keeping a suspended Run live;
- the start and end of each Stretch, and every addition to the Pump's and the Script's Fuel totals;
- the one path that faults a Run whose Charge was refused. It decides whether the fault ends the Segment or the whole Run, and which call it abandons.

It does not own the Trace, Run scheduling or Waits. It holds no reference to the Group. It works on a Run, its Script's lists and a meter for the two Fuel totals. The Group's turn loop still picks which Run goes next. `machine.zig` writes every `preempt`, `seg`, `fault` and `abandon` record from what the module returns. The Wait table keeps the Waits ([ADR 0105](0105-each-core-keeps-its-waits-in-one-wait-table-module.md)).

Hosts cannot observe the module. Trace output, save bytes and the C API stay the same.

## Considered Options

- **Moving the lifecycle into the Wait table**: ADR 0105 keeps Run scheduling out of the Wait table. A Run's lifecycle covers preemption and crossing pauses, which have nothing to do with Waits.
- **Letting the module write the Trace**: the records' order is fixed and must stay byte-identical. Also, the module's tests could then no longer run on bare Runs.
- **Deduplicating the copies in place, inside `machine.zig`**: this would remove the copies but not the flags. The Run's state would still be inferred, as in the Rewind check.
- **The TS Core too**: these bugs were in the Zig Core. If the TS Core adopts this module shape, it will be a separate change.

## Consequences

- The changes are refactors. Trace output, save bytes and the Corpus stay identical. That includes the differences between the fault paths: a Charge refused at a crossing writes no `seg` record. Any real bug found while moving code ships as its own fix.
- The module's tests build bare Runs and lists, with no Group, Script or Trace. The end-to-end tests and the Conformance Corpus stay as integration coverage.
- "Park" now means only a Parked Run. The function that puts a paused Run back at the head of its Script's work is called `requeueAtHead`.
