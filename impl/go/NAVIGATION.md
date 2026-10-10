# Go task navigation

Start with the row for your task, then read the linked rules and tests. Read the
[implementation guide](README.md) when you need feature details or limitations.
List paths with `rg --files` in the relevant directory before opening files by
name. For domain terms, use [CONTEXT.md](../../CONTEXT.md); for rationale, use the
[ADR index](../../docs/adr/README.md).

All commands below run from the repository root. On a fresh worktree, run
`bun install --frozen-lockfile` and `bun run unicode:check` before focused tests;
the Unicode check prepares and verifies the pinned test data. See the
[Spec change-impact guide](../../docs/agents/spec-changes.md) when changing Data
Files, grammar, or lowering.

| Task | Implementation | Rules | Tests and cases | First check |
| --- | --- | --- | --- | --- |
| Lexing and parsing | [syntax](internal/syntax/), [Selectors](internal/syntax/selector.go) | [lexical structure](../../spec/01-lexical-structure.md), [grammar](../../spec/02-grammar.md) | [lexer tests](internal/syntax/lexer_test.go), [parser tests](internal/syntax/parser_test.go) | `go -C impl/go test ./internal/syntax` |
| Name and binding checks | [checker](internal/check/check.go) | [load diagnostics](../../spec/02-grammar.md#load-time-diagnostics) | [checker tests](internal/check/check_test.go), [load diagnostics](../../corpus/load-diagnostics/) | `go -C impl/go test ./internal/check` |
| Lowering and source maps | [lowering entry](internal/lower/unit.go) | [Abstract Machine](../../spec/08-the-abstract-machine-and-the-cost-model.md) | [lowering tests](internal/lower/lower_test.go), [disassembly cases](../../corpus/disassembly/) | `go -C impl/go test ./internal/lower` |
| Execution and resource costs | [machine](internal/machine/) | [Abstract Machine and costs](../../spec/08-the-abstract-machine-and-the-cost-model.md), [limits](../../spec/06-errors-and-limits.md) | [machine tests](internal/machine/machine_test.go), [execution tests](execution_test.go), [limit cases](../../corpus/limits/) | `go -C impl/go test ./internal/machine .` |
| Dispatch, scheduling and waits | [Host inputs](group.go), [Run scheduling](group_run.go), [message observation](group_observe.go), [sends](group_send.go) | [scheduling](../../spec/05-handlers-messages-and-scheduling.md), [embedding](../../spec/09-embedding.md) | [error delivery](error_delivery_test.go), [waits](wait_test.go), [message waits](wait_for_test.go), [sends](send_wait_test.go) | `go -C impl/go test .` |
| Capability Operations | [definitions and Grants](capability.go), [Shapes](shape.go), [load checks](internal/check/operations.go), [Operation invocation](group_operation.go), [Host Crossings and resumes](group_crossing.go) | [Capabilities and Shapes](../../spec/09-embedding.md#capabilities), [costs](../../spec/08-the-abstract-machine-and-the-cost-model.md) | [embedding tests](capability_test.go), [Capability cases](../../corpus/capabilities/) | `go -C impl/go test . ./internal/check` |
| Capability Scopes, Segment-bound effects and Coordinators | [Scopes](group_scope.go), [participants and Coordinators](group_effect.go) | [Scopes and Segment-bound effects](../../spec/09-embedding.md#capability-scopes-and-segment-bound-effects), [worked examples](../../spec/embedding/scoped-effects.md) | [Segment effect tests](segment_effect_test.go), [Scope tests](scope_test.go), [`effect-*` Capability cases](../../corpus/capabilities/) | `go -C impl/go test . -run 'Segment|Scope'` |
| Libraries and Standard Library | [compilation and registration](library.go), [normative sources](stdlib.go), [Function binding](internal/machine/library.go) | [Libraries](../../spec/07-libraries-and-the-standard-library.md), [identity](../../spec/09-embedding.md#loading-and-libraries) | [public Library tests](library_test.go), [Library cases](../../corpus/libraries/), [stdlib cases](../../corpus/stdlib/) | `go -C impl/go test . ./internal/machine` |
| Save, restore and code updates | [snapshot DTOs](save.go), [rehydration](restore.go), [save-format version](core.go), [settlements](settle.go), [Extend](script_extend.go), [replacement](library_replace.go) | [save and restore](../../spec/10-save-and-restore.md), [Fingerprint](../../spec/09-embedding.md#the-pump-and-the-group-fingerprint) | [snapshot tests](save_test.go), [extension tests](extend_test.go), [save/restore cases](../../corpus/save-restore/) | `go -C impl/go test . ./internal/snapshot` |
| Text Patterns | [lowering](internal/lower/pattern.go), [values](internal/value/pattern.go), [Pike VM](internal/machine/pattern.go) | [Text Pattern programs](../../spec/08-the-abstract-machine-and-the-cost-model.md#text-pattern-programs) | [public acceptance](pattern_test.go), [VM tests](internal/machine/pattern_test.go), [pattern cases](../../corpus/text-patterns/) | `go -C impl/go test . ./internal/machine` |
| Generated tables | [Go generator](../../tools/go/generate.ts), [Unicode generator](../../tools/unicode/generate.ts), [syntax generator](../../tools/syntax/generate.ts) → [tables](internal/generated/) | [Data Files](../../spec/README.md#data-files) | [generator tests](../../tools/go/generate.test.ts), [Unicode tests](internal/unicode/unicode_test.go) | `bun run go:check` |
| Sessions, REPL and Transcripts | [Host](session/host.go), [Session Commands](session/commands.go), [observation](session/observe.go), [`:describe`](session/describe.go), [inspection](session/inspect.go), [drivers](driver/), [CLI](cmd/northtalk/) | [Entries](../../spec/02-grammar.md#entries), [sessions](../../spec/12-sessions-and-tooling.md), [Session observation](../../spec/session-observation.md) | [Host tests](session/host_test.go), [REPL tests](driver/repl_test.go), [Session parity](internal/corpus/session_test.go), [Transcripts](../../corpus/sessions/) | `go -C impl/go test ./session ./driver` |
| Message Layer, sidecar and WASI reactor | [Session and handlers](internal/messagelayer/), [sidecar](cmd/messagelayer/main.go), [reactor](cmd/messagelayer-wasi/main_wasip1.go) | [the Message Layer](../../spec/09-embedding.md#the-message-layer), [build and Host framing](README.md#wasi-reactor) | [Session tests](internal/messagelayer/session_test.go), [framing tests](internal/messagelayer/framing_test.go), [wasmtime check](../../tools/wasi/check.py) | `go -C impl/go test ./internal/messagelayer`; build the reactor and run `uv run tools/wasi/check.py .cache/messagelayer.wasm` as the guide describes |
| Differential fuzz worker | [command](cmd/fuzzworker/main.go), [runner and protocol](internal/fuzz/), [replay Host](internal/corpus/replay_host.go) | [dual-Core mode](../../tooling/fuzz/README.md#dual-core-mode), [ADR 0009](../../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md) | [worker tests](internal/fuzz/worker_test.go), [dual-Core tests](../../tooling/fuzz/tests/go-runner.test.ts) | `go -C impl/go test ./internal/fuzz` |
| Corpus selection and parity | [CLI](cmd/corpus/main.go), [runner](internal/corpus/runner.go), [passing gate](corpus-passing.txt) | [corpus commands and blessing](../../corpus/README.md#checking), [conformance](../../spec/11-the-trace-and-conformance.md) | [runner tests](internal/corpus/corpus_test.go), [execution backends](internal/corpus/execution_test.go) | `go -C impl/go run ./cmd/corpus --check-passing` |

The [implementation guide](README.md) describes the supported subset and its limits. Follow Spec links for rules and the [ADR index](../../docs/adr/README.md) for rationale. The TS Core is a parity peer; root `tools/grammar/` and `tools/machine/` are Spec-checking prototypes. Update generated files through their generators.

Packages outside the root reach Group internals through hooks: a root `*_hooks.go`
file ([replay_hooks.go](replay_hooks.go), [documentation_hooks.go](documentation_hooks.go))
assigns function variables in an `internal/` package from `init`, and `session/`
calls them. Fixtures both Cores read, such as Declaration Documentation, live in
[impl/testdata/](../testdata/). A save-format change bumps `SaveFormat` in
[core.go](core.go) and `saveFormatVersion` in the TS
[snapshot.ts](../ts/src/snapshot.ts). Add corpus cases as
[the corpus guide](../../corpus/README.md#adding-a-case) describes.

Standard Capability construction lives in [standard_capability.go](standard_capability.go). Session cases use `corpus/sessions/<case>/session.transcript` with a companion `case.trace`; discover case names with `rg --files corpus/sessions`. Check Transcript parity with `go -C impl/go test ./internal/corpus -run TestSession`. For a single test, append `-run TestName` to the appropriate `go -C impl/go test` command.

These checks start the feedback loop; use the implementation guide and CI workflows for broader validation before completing a change.

Store Host semantics live in [store/](store/), with the fixed Core factory in
[store_capability.go](store_capability.go). The language-neutral runner lives in
[internal/storekit/](internal/storekit/); run `go -C impl/go run ./cmd/storekit`
or `go -C impl/go test ./store ./internal/storekit ./session` for Store changes.

The optional `sqlite` factory lives in [sqlite_capability.go](sqlite_capability.go),
with its corpus runner Stubs in [internal/corpus/sqlite.go](internal/corpus/sqlite.go);
check it with `go -C impl/go test . ./internal/corpus -run Sqlite` and the
`standard-sqlite*` Capability cases. The Host implementation on a real database
is the separate module [sqlite/](sqlite/), which runs the
[sqlite kit](../../corpus/sqlite-kit/) through
[internal/sqlitekit/](internal/sqlitekit/); check it with
`go -C impl/go/sqlite test ./...`.

The optional `user` factory lives in [user_capability.go](user_capability.go),
with its corpus runner Stubs in [internal/corpus/operations.go](internal/corpus/operations.go);
check it with `go -C impl/go test . -run User` and the `standard-user*`
Capability cases.
