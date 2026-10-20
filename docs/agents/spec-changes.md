# Changing the Spec and its consumers

Before splitting a language change into specification and implementation PRs,
check the affected rows below. Commands run from the repository root after
`bun install --frozen-lockfile`; Go generation also requires the Go version in
the [build guide](../../impl/go/README.md#build-and-test).

| Change | Regenerate | Implementation and acceptance obligations |
| --- | --- | --- |
| Grammar productions or keywords (`grammar.ebnf`, `grammar.toml`) | `bun run spec:gen`, `bun run syntax:generate`, `bun run go:generate`, `bun run zig:generate` | Update the [reference parser](../../tools/grammar/parser.ts) and the TS and Zig Core parsers. Shared sketches and broken sources are consumed by Core tests too; check `bun run grammar:check` and each Core's parser tests. |
| Instructions or costs (`machine.toml`, `costs.toml`) | `bun run spec:gen`, `bun run syntax:generate`, `bun run go:generate`, `bun run zig:generate` | Update [reference lowering](../../tools/machine/compile.ts), Core lowering/execution, and Disassembly/Trace cases. [TS](../../impl/ts/tests/lowering.test.ts) requires Disassembly cases to emit every declared instruction. `bun run machine:check` alone does not prove Core coverage. |
| Advanced tags in `grammar.toml` | `bun run spec:gen`, `bun run lints:generate` (after syntax generation if keywords also changed) | Update recognition and fixtures in the [Lint engine](../../tooling/stack/src/lint.ts) and [Lint tests](../../tooling/stack/tests/lint.test.ts). Every Advanced tag needs an exercised fixture with its beginner wording. |
| Errors, diagnostics, limits, units or Built-ins | `bun run spec:gen`, `bun run syntax:generate`, `bun run go:generate`, `bun run zig:generate` | Check the relevant Core behavior, error fields and resource costs; changing generated catalogues does not implement a new behavior. |
| Normative Standard Library source (`spec/stdlib/`) | `bun run syntax:generate`, `bun run go:generate`, `bun run zig:generate`; also `bun run spec:gen` if catalogue declarations changed | Run affected Library cases on all three Cores and check errors, positions and costs. |
| Envelope tags or fields (`envelope.toml`) | `bun run envelope:generate` | Check all four codecs against `impl/testdata/envelope-frames.json`; every message and Report tag needs a reviewed vector. Keep codec reshaping hand-written and record cross-Core disagreements as issues. New vectors need human first review; wire changes require the ordinary compatibility decision. |
| Unicode pins (`unicode.toml`) | `bun run spec:gen`, `bun run unicode:generate` | The generator verifies pinned downloads and writes all three Cores' tables. Run all three Unicode suites with the verified cache. |
| Embedding declarations, Trace or Session formats | `bun run spec:gen`; `bun run go:generate` and `bun run zig:generate` when `corpus.toml` changes; `bun run lints:generate` when `session.toml` changes | Check the Go and C API comparisons and affected Session/Trace cases on each Core; see [replay modes and backends](../../corpus/README.md#replay-modes-and-backends). Follow the [Data File index](../../spec/README.md#data-files) for the normative source. |
| Host error codes (`host-errors.toml`) | `bun run spec:gen` | The code unions are written by hand: add the code to `HostErrorCode` in [talk.ts](../../spec/embedding/talk.ts) and [talk.go](../../spec/embedding/talk.go), then to [errors.ts](../../impl/ts/src/errors.ts) and [core.go](../../impl/go/core.go). Reconcile the C enum in [talk.h](../../impl/zig/include/talk.h) and its [Zig exports](../../impl/zig/src/talk.zig) too. |

Read the corresponding [TS/tooling](../../impl/ts/NAVIGATION.md),
[Go](../../impl/go/NAVIGATION.md) and [Zig](../../impl/zig/NAVIGATION.md) rows for implementation files and focused tests.
Generators own generated files. After regeneration, run `bun run check`,
`bun run go:check` and `bun run zig:check`, then affected Core/tooling tests and
cross-Core corpus cases.

## Splitting delivery

A spec-only PR that introduces instructions or Advanced tags can fail Core or
tooling coverage even when Spec checks pass. Decide the delivery boundary before
editing those catalogues. [ADR 0057](../adr/0057-a-send-may-compute-its-message-name.md)
records one staged delivery: prose and grammar landed first; instruction data,
lowering and the Advanced tag landed with implementation. Temporary grammar
cases were kept outside the sketches consumed by both Cores, then moved into
the shared suite when both could parse them.

Record any such staging explicitly in the [implementation handoff](issue-tracker.md#specification-handoffs),
including deferred files and cleanup. It is a delivery decision, not a reason
to weaken coverage tests. Keep expectation approval separate from execution
agreement; the [corpus guide](../../corpus/README.md#checking) owns that workflow.
