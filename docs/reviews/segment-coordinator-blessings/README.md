# Segment Coordinator expectation approval

On 2026-10-08, the maintainer explicitly approved the four cases below in the
#228 conversation: “i approve the test outputs”.

## Approved cases

- `capabilities/effect-coordinator-shared`
- `capabilities/effect-coordinator-commit-failed`
- `capabilities/effect-coordinator-abandon-failed`
- `capabilities/effect-coordinator-conflict`

Only the `Unblessed` comment header changes in these expectations. Host Inputs,
Core output records, source positions, code identities, Fuel and allocation
stay byte for byte as [PR #465](https://github.com/odogono/odgn-talk/pull/465)
produced them.

## Evidence and boundaries

The TS Core from PR #465 produced each Trace, and the TS runner checked it in
ordinary, save/restore and recorded-result replay. The Go Core from
[PR #464](https://github.com/odogono/odgn-talk/pull/464) reproduces all four
unchanged, and they are in its passing gate.

The review settled one point the Spec left open. In
`effect-coordinator-abandon-failed`, the Run ended by a failed abandonment
names `alias`, the Grant whose abandonment failed, not the first enrolled `r`.
The [lifecycle contract](../../../spec/embedding/scoped-effects.md#segment-participant)
and ADR 0069 now say so; both Cores already behaved this way.

The Store's shared coordinator is not covered here; it follows in #461.

The expectation review follows
[chapter 11](../../../spec/11-the-trace-and-conformance.md#bless).
