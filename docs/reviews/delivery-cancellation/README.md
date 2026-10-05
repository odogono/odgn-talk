# Delivery cancellation replay reconciliation

[Go step 3 (#134)](https://github.com/odogono/odgn-talk/issues/134) requires
`decisions/undecided-on-cancel-delivery` to run through the embedding interface.
The Go runner now cancels the context of its public Request, Decision or Host
Function Value call and waits for `OnReady` before issuing the next input.
Already settled or already cancelled handles need no notification. The TS
runner supplies public AbortSignals to the same calls.

## Trace correction

[Chapter 9](../../../spec/09-embedding.md#decisions) and
[ADR 0031](../../adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md)
require cancellation after a Verdict seals to do nothing. Both public APIs
already implement that rule. The old TS replay hook queued `cancel-delivery`
unconditionally, producing an input line a real post-seal signal abort cannot
produce.

The corrected `decisions/undecided-on-cancel-delivery` Trace removes only
`> cancel-delivery d3` after the allowed Verdict. Its 26 remaining records,
including every id, outcome, Fuel, allocation, Persistent State and final
Variable, are unchanged. Its `Unblessed` header awaits human review of this
correction; producing agreement does not approve that review.

Native runner tests in both Cores inject that otherwise unrecorded action
before the answer and require the same complete Trace. They retain the
after-seal stimulus without adding an input that the Core never queues.
The pre-seal abort still removes the Decision from the mailbox, reports a
cancelled Run without a Run id, and seals it as undecided.

Go execution and TS ordinary/save-restore replay agree before the TS `--bless`
procedure records the correction. Chapter 11 excludes hidden save/restore
boundaries that would strand a later cancellation's original context or signal;
the second replay preserves those handles as specified. Go save/restore remains
outside this slice.

`functions/host-cancellation` additionally passes unchanged on Go. Its
17 records pin cancellation cleanup for a suspended Host Function Value call.
Both cases enter the Go passing gate, raising it from 205 to 207 cases.

Plain `Deliver` has no context or signal in the public interface. The existing
`counters/faults-and-cleanup` fixture cancels such a Delivery and remains deferred
by the Go runner; it is outside step 3's acceptance directories.
