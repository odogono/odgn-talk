# Computed-send expectation approval

On 2026-10-05, the maintainer explicitly approved the four cases below in the
issue-357 conversation: “have reviewed the trace cases - approved”.

## Approved cases

- `computed-sends/names`
- `computed-sends/forwarding`
- `computed-sends/unhandled`
- `computed-sends/bad-names`

Only the `Unblessed` comment header changes in these expectations. Host Inputs,
Core output records, source positions, code identities, Fuel and allocation
stay byte for byte the same. Removing the markers puts these cases in the TS
runner's default selection.

## Evidence and boundaries

The implementation is in [PR #358](https://github.com/odogono/odgn-talk/pull/358)
(ADR 0057). Both Cores reproduce each complete Trace, and the TS runner also
checks it in Save/Restore replay. The four cases are required in the Go
passing gate. The `disassembly/messages-and-waiting` unit `router.dis` is
outside this approval.

The expectation review follows
[chapter 11](../../../spec/11-the-trace-and-conformance.md#bless).
