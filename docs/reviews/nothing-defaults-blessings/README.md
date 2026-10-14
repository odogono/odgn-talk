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
Both witnesses received their own first-blessing approval on 2026-10-14,
as recorded below.

The expectation review follows
[chapter 11](../../../spec/11-the-trace-and-conformance.md#bless).

## Follow-up verification and approval (2026-10-14)

At `9b50c52f`, the original nine cases and both follow-up witnesses agree on
TS, Go and Zig, including ordinary and Save/Restore replay for the ten Trace
Cases. The Disassembly Case also agrees. `bun run check` passes, including
Spec generation, grammar, lowering, corpus structure and documentation links.

The follow-up fixes merged in [#771](https://github.com/odogono/odgn-talk/pull/771)
(Go Handler-name locals) and [#770](https://github.com/odogono/odgn-talk/pull/770)
(Zig initializer diagnostics). Their separate witnesses supply acceptance
groups 9 and 8 respectively; duplicating them into the original cases is not
needed to exercise the behavior.

The maintainer reviewed and accepted the following expectations in the #722
implementation conversation on 2026-10-14 ("have reviewed and accept them"):

- [`corpus/nothing-defaults/handler-name-locals/case.trace`](../../../corpus/nothing-defaults/handler-name-locals/case.trace):
  a local `otherwise` coexists with its Handler; the command returns `40`,
  the grouped index reads `5`, and `nothing otherwise otherwise` returns `1`.
  The three Runs consume 67, 99 and 69 Fuel, totaling 235.
- [`corpus/load-diagnostics/constant-unknown-name/case.trace`](../../../corpus/load-diagnostics/constant-unknown-name/case.trace):
  all eight rejected loads report `unknown name` followed by `not constant`
  at the same token, including the unselected fallback at 1:26, the Script
  Variable initializer at 1:33 and the parameter default at 1:34.

Their `Unblessed` headers are removed on that approval. All other Trace
bytes, including source positions, identities, Fuel and allocation, remain
unchanged. No first-blessing approvals remain outstanding for #722; landing
this approval record and reconciling #722 and its parent #687 remain.
