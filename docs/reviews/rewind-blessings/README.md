# Rewind expectation approval

On 2026-10-08, the maintainer explicitly approved the seven cases below in the
#433 conversation: “approve as is”.

## Approved cases

- `rewind/at-crossing`
- `rewind/decision-at-crossing`
- `rewind/effects`
- `rewind/message-kinds`
- `rewind/not-rewindable`
- `rewind/parked-queued`
- `rewind/preempted-request`

Only the `Unblessed` comment header changes in these expectations. Host Inputs,
Core output records, source positions, code identities, Fuel and allocation
stay byte for byte as [PR #442](https://github.com/odogono/odgn-talk/pull/442)
produced them.

## Evidence and boundaries

PR #442 added Rewind to both Cores together, and the TS runner blessed these
Traces with the Go Core agreeing. At `901c9a2`, the TS runner passes all seven,
and the Go Core passes them in its passing gate.

The Trace doesn't carry Run accounting, so the `run discarded` report with
reason `rewind` is pinned by the API tests in `impl/ts/tests/rewind.test.ts`
and `impl/go/rewind_test.go`, not by these cases.

Two of #433's corpus criteria have no case here: a keep-mailbox Reload that
changes the Script Variables' shape (`at-crossing` keeps `n` as it was), and a
rolled-back Store write (`effects` rolls back a `resource` participant). They
follow in #481.

The expectation review follows
[chapter 11](../../../spec/11-the-trace-and-conformance.md#bless).
