# Nothing defaults expectation approval

On 2026-10-13, the maintainer reviewed and accepted the cases below, after
[PR #755](https://github.com/odogono/odgn-talk/pull/755) and
[PR #766](https://github.com/odogono/odgn-talk/pull/766) merged.

## Approved cases

- `disassembly/nothing-defaults` (#719)
- `nothing-defaults/values` (#722)
- `nothing-defaults/evaluation-order` (#722)
- `nothing-defaults/fuel-boundaries` (#722)
- `nothing-defaults/guards` (#722)
- `nothing-defaults/host-objects` (#722)
- `nothing-defaults/stdlib-attribution` (#722)
- `nothing-defaults/compatibility` (#722)
- `load-diagnostics/nothing-defaults` (#722)

Only the `Unblessed` comment headers change in these expectations. Disassembly,
Core output records, source positions, code identities, Fuel and allocation
stay byte for byte as those PRs recorded them.

## Evidence and boundaries

The TS Core wrote `defaults.dis`, and the Go and Zig Cores match it. `bun run
corpus:bless` wrote the Traces with the TS and Go runners agreeing, and Zig
produces them bit for bit, in ordinary and save/restore replay. The cases are in
the Go and Zig passing gates. The
[design's acceptance table](../../design/nothing-defaults.md#acceptance-cases)
maps each case to its acceptance groups.

Two cases avoid Core gaps that have since been fixed.
`nothing-defaults/compatibility` has no local named like a Handler because of
#764, whose witness is
[`nothing-defaults/handler-name-locals`](../../../corpus/nothing-defaults/handler-name-locals/).
`load-diagnostics/nothing-defaults` tests the unknown-name fallback inside a
Handler, not a Constant, because of #765, whose witness is
[`load-diagnostics/constant-unknown-name`](../../../corpus/load-diagnostics/constant-unknown-name/).
Each witness needs its own first blessing.

The expectation review follows
[chapter 11](../../../spec/11-the-trace-and-conformance.md#bless).
