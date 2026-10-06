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

## Queued Request cancellation correction (#364)

At the step-3 review above, `counters/faults-and-cleanup` remained deferred:
it cancelled a plain `Deliver`, which has no context or signal in the public
interface. That stimulus was outside step 3's acceptance directories. The
2026-10-06 correction uses `request d2 to=s message=clean`, followed by
`cancel-delivery d2`, through the public context/signal in both Cores.
Chapter 9 now explicitly states that a plain Delivery's id cannot queue this
cancellation. This clarifies the existing interface; no cancellation API is added.

### Spec derivation

- [Chapter 9's input queue rules](../../../spec/09-embedding.md#threads-and-the-input-queue)
  drain the Request and its cancellation in order before dispatch. The
  cancellation removes `d2` from the mailbox and reports `cancelled` without a
  Run or Handler. [Chapter 11's Run ids](../../../spec/11-the-trace-and-conformance.md#ids)
  therefore leave the next actual Run as `s/r2`.
- With no dispatch or executed instruction, Cost Model 0 charges no Fuel or
  allocation. The cancellation's `run` retains `fuel=0 alloc=0`, and its Pump
  retains `fuel=0`. A Request's future settles at the end of the Pump; chapter
  11 adds no separate Trace output for that Host future.
- [The Script counter rules](../../../spec/09-embedding.md#script-counters)
  count no new Run or fault and retain the previous fault's spent work. The
  following snapshot remains `fuel=30 alloc=0 runs=1 faults=1 state=16 mailbox=0`:
  the original `n=0` binding survives rollback, with no mailbox message or Run
  left to retain. The later `clean` Run and its failed cleanup are unchanged,
  so the final snapshot remains `fuel=53 alloc=0 runs=2 faults=1 state=16 mailbox=0`.

Only `> deliver d2` changes to `> request d2`; all 33 other non-comment records
are unchanged. Go and TS reproduce the complete 34-record Trace in ordinary
and save/restore replay before TS `--bless` records it. The save/restore replay
preserves any original cancellation handle needed by a later input, under
[chapter 11's futures rule](../../../spec/11-the-trace-and-conformance.md#save-and-restore-replays).

TS replay now rejects `cancel-delivery` without a Request, Decision or Host
Function Value call cancellation handle, including unknown ids, rather than
falling back to the internal Delivery hook. Native TS counter coverage uses
an AbortSignal too. A Go required-case test protects all three Counters cases,
including their passing-gate membership and support classification. Current
runner support is described in the [Go guide](../../../impl/go/README.md#corpus-runner)
and the [TS guide](../../../impl/ts/README.md#verification-and-corpus-selection).

The corrected case retains `Unblessed` pending human review of this change.
Cross-Core execution agreement and running `--bless` do not provide that approval.
