# Implicit property target Trace approval

On 2026-10-13, the maintainer approved
[`objects/implicit-property-targets/case.trace`](../../../corpus/objects/implicit-property-targets/case.trace)
and
[`load-diagnostics/implicit-property-targets/case.trace`](../../../corpus/load-diagnostics/implicit-property-targets/case.trace)
in the issue-744 conversation: “i have looked over the trace files and approve them”.

The `objects` Trace pins whole-property `set` through `me`, `it` and
`the target`, including quoted, computed and parenthesized keys, receivers
found through a list item and a map key, and Target differing from `me` during
ancestor handling. It records runtime `read only` through `it`, `the target`
and a variable key on `me`, and `wrong kind` for non-Object receivers.

The `load-diagnostics` Trace pins `can't write` at `2:3` for literal and
parenthesized keys on an Owning Script's `me`, and `not a container` at each
target's first token for bare implicit roots, `put`, `delete`, `add` and
`multiply` through them, chunk targets and Built-in properties. It also pins
`not in a lambda` for `the target` inside a Lambda.

Only the approval comments change in the Traces. TS and Go agreed on both when
blessed, and the Zig Core replays both. Current support is described in the
[Go](../../../impl/go/README.md), [TS](../../../impl/ts/README.md) and
[Zig](../../../impl/zig/README.md) implementation guides.

The first-blessing workflow is defined in
[chapter 11](../../../spec/11-the-trace-and-conformance.md#bless).
