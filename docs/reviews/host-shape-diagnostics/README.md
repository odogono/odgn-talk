# Host Shape diagnostic Trace approval

On 2026-10-14, the maintainer approved
[`capabilities/argument-shape-diagnostics/case.trace`](../../../corpus/capabilities/argument-shape-diagnostics/case.trace)
in the issue-846 conversation: “i have reviewed it and it is fine”.

The Trace covers 24 Capability argument failures: Function Values under scalar,
container, declared-field, closed-map-extra, Quantity, Unit Kind, union and
Optional Shapes; data scans under `any` and open-map undeclared fields; and
Quantity diagnostics under ordinary, Quantity, Unit Kind, union and Optional
Shapes. It pins error codes, fields, paths, source positions and resource figures.

TS, Go and Zig agreed at blessing, including ordinary and automatic Save/Restore
replay. Full corpus runs on all three Cores, Zig unit and C Host tests, Go corpus
tests and repository checks passed before approval. Approval changes only the
Trace's header; its Host Inputs and output records remain unchanged. Current
support is described in the [Zig implementation guide](../../../impl/zig/README.md).

The first-blessing workflow is defined in
[chapter 11](../../../spec/11-the-trace-and-conformance.md#bless).
