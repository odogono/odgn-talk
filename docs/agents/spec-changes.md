# Changing the Spec and its consumers

Before splitting a language change into specification and implementation PRs,
check the affected rows below. Commands run from the repository root after
`bun install --frozen-lockfile`; Go generation also requires the Go version in
the [build guide](../../impl/go/README.md#build-and-test).

| Change | Regenerate | Implementation and acceptance obligations |
| --- | --- | --- |
| Grammar productions or keywords (`grammar.ebnf`, `grammar.toml`) | `bun run spec:gen`, `bun run syntax:generate`, `bun run go:generate` | Update the [reference parser](../../tools/grammar/parser.ts) and both Core parsers. Shared sketches and broken sources are consumed by Core tests too; check `bun run grammar:check` and each Core's parser tests. |
| Instructions or costs (`machine.toml`, `costs.toml`) | `bun run spec:gen`, `bun run syntax:generate`, `bun run go:generate` | Update [reference lowering](../../tools/machine/compile.ts), Core lowering/execution, and Disassembly/Trace cases. [TS](../../impl/ts/tests/lowering.test.ts) and [Go](../../impl/go/internal/lower/lower_test.go) require Disassembly cases to emit every declared instruction. `bun run machine:check` alone does not prove Core coverage. |
| Advanced tags in `grammar.toml` | `bun run spec:gen`, `bun run lints:generate` (after syntax generation if keywords also changed) | Update recognition and fixtures in the [Lint engine](../../tooling/stack/src/lint.ts) and [Lint tests](../../tooling/stack/tests/lint.test.ts). Every Advanced tag needs an exercised fixture with its beginner wording. |
| Errors, diagnostics, limits, units or Built-ins | `bun run spec:gen`, `bun run syntax:generate`, `bun run go:generate` | Check the relevant Core behavior, error fields and resource costs; changing generated catalogues does not implement a new behavior. |
| Normative Standard Library source (`spec/stdlib/`) | `bun run syntax:generate`, `bun run go:generate`; also `bun run spec:gen` if catalogue declarations changed | Run affected Library cases on both Cores and check errors, positions and costs. |
| Unicode pins (`unicode.toml`) | `bun run spec:gen`, `bun run unicode:generate` | The generator verifies pinned downloads and writes both Cores' tables. Run both Unicode suites with the verified cache. |
| Embedding declarations, Trace or Session formats | `bun run spec:gen`; `bun run go:generate` when `corpus.toml` changes | Check API comparisons, both replay backends and affected Session/Trace cases. Follow the [Data File index](../../spec/README.md#data-files) for the normative source. |

Read the corresponding [TS/tooling](../../impl/ts/NAVIGATION.md) and
[Go](../../impl/go/NAVIGATION.md) rows for implementation files and focused tests.
Generators own generated files. After regeneration, run `bun run check` and
`bun run go:check`, then affected Core/tooling tests and cross-Core corpus cases.

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
