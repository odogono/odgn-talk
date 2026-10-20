# Container property Trace approval

On 2026-10-12, the maintainer approved
[`load-diagnostics/container-properties/case.trace`](../../../corpus/load-diagnostics/container-properties/case.trace)
in the issue-681 conversation: “i have examined the trace and accept it”.

The approval covers the merged expectation from [PR #680](https://github.com/odogono/odgn-talk/pull/680),
commit `5cb62634cf4b9e24b3ce53920f092c7e22c9238e`, rather than the
superseded expectation from closed PR #683. It pins `not a container` for direct,
intermediate and possessive Built-in property targets at `2:14`, `2:10` and
`2:7`. The valid Script preserves quoted/computed keys and an auxiliary property
read, ending with `vars keys m={length: 1, size: 5} t="x,b,c"`, Fuel 59,
allocation 97 and state 127.

Only the approval comment changes in the Trace. All Host Inputs, output records,
identities, source positions and resource figures remain byte for byte unchanged.
TS and Go reproduce its 14 records in ordinary and automatic Save/Restore replay
at base `045897c48262f563e23fa4ed639bc631b01df180` with the #681 follow-up.

The Go follow-up unwraps parenthesized `set` targets before checking and lowering
their keys. Host Object regressions verify quoted/computed keys, nested
parentheses, exactly one setter invocation without a property read, read-only
Load rejection and bare-variable diagnostics. Current support is described in
the [Go implementation guide](https://github.com/odogono/odgn-talk/blob/8df027ac174cc42a47d4ad14725bcaea768ddee7/impl/go/README.md#front-end-and-lowering-checks)
and [TS implementation guide](../../../impl/ts/README.md).

The first-blessing workflow is defined in
[chapter 11](../../../spec/11-the-trace-and-conformance.md#bless).
