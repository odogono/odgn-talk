# Collecting Clause implementation evidence

Implementation for #380, checked on 2026-10-06 against the specification at
`a575e7594881c9571e9c44836843a66f6041e64a` (merged #379 / ADR 0059).

Both Cores reproduce the six new Trace Cases in ordinary and save/restore
replay. They also produce identical `collect.dis`, including initialization
before every head and each generated append instruction's `collecting` position.

| Case | Evidence |
| --- | --- |
| [zero-passes](../../../corpus/collecting/zero-passes/case.trace) | All finite heads initialize an empty target when no pass runs. |
| [next-filter](../../../corpus/collecting/next-filter/case.trace) | `next repeat` skips collection; the expression sees the completed body's writes. |
| [exit](../../../corpus/collecting/exit/case.trace) | Early exit skips collection in both iterator and forever loops. |
| [partial-error](../../../corpus/collecting/partial-error/case.trace) | A failing collected expression leaves earlier elements intact. |
| [condition-target](../../../corpus/collecting/condition-target/case.trace) | `while` and `until` read the target so far; the count reads its newly initialized target. Lists collect as individual elements. |
| [waiting-body](../../../corpus/collecting/waiting-body/case.trace) | Waiting bodies retain partial lists across Pumps and restore; collection follows completion of the body. |
| [Disassembly](../../../corpus/disassembly/collecting/collect.dis) | Every head, destructured iteration, filtering and early exit, with exact slots and source positions. |

Current support is described in the [TS guide](../../../impl/ts/README.md),
[Go guide](../../../impl/go/README.md) and [Lint guide](../../../tooling/stack/README.md#lints).
The Go passing gate and both Cores' acceptance tests require these cases even
while the expectations remain unblessed.

Verification: the full Bun workspace suite, all Go packages, spec/generator
checks, Go passing gate, lint/format checks, type checking, builds and the
Node tooling/CLI compatibility fixtures pass. Checker regressions also cover
Constant/object clashes, nested pattern bindings, captured writes and local
Handler shadowing.

First-blessing approval is separate from execution agreement. Maintainer review
for all six linked `case.trace` files and `collect.dis` was given on 2026-10-07;
see the [approval record](../milestone-one-blessings/README.md). No existing corpus expectation was changed.
