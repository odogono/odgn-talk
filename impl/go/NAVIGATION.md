# Go task navigation

Find your task's heading (`rg -n '^## ' impl/go/NAVIGATION.md` lists them), then read the linked rules and tests. Read the
[implementation guide](README.md) when you need feature details or limitations.
List paths with `rg --files` in the relevant directory before opening files by
name: the root package is flat, named by area (`group_*.go`, `zig_*.go`), and
has no `script.go`, `types.go` or `report.go`. Pump and Run report types are in
[`execution_types.go`](execution_types.go). For domain terms, use [GLOSSARY.md](../../GLOSSARY.md); for rationale, use the
[ADR index](../../docs/adr/README.md).

All commands below run from the repository root. See the
[Spec change-impact guide](../../docs/agents/spec-changes.md) when changing Data
Files, grammar, or lowering.

## Language, lowering and execution

The Go module runs the embedded Zig Core, with no Go parser, checker, compiler or interpreter (#1055). Lexing, checking, lowering, execution, costs, Built-ins and recovery are the [Zig task map](../zig/NAVIGATION.md)'s. Host-side value helpers: Core error maps, logical size and `Add` in [valueops](internal/valueops/), and Selector and label validation in [syntax](internal/syntax/), a lexer only. Text Pattern sizes come from [the value reader's tree](internal/value/pattern.go).

## Values and collections

- Implementation: [values](internal/value/value.go), [Lists](internal/value/list.go), [Maps](internal/value/map.go), [persistent trees](internal/value/tree.go)
- Rules: [Lists and maps](../../spec/03-values.md#lists-and-maps), [costs](../../spec/08-the-abstract-machine-and-the-cost-model.md)
- Tests and cases: [collection tests](internal/value/collections_test.go), [layout tests](internal/value/layout_test.go)
- First check: `go -C impl/go test ./internal/value`

## Value Encoding

- Implementation: [encoder and decoder](encoding.go)
- Rules: [JSON and the Value Encoding](../../spec/09-embedding.md#json-and-the-value-encoding), [encoding cases](../../spec/11-the-trace-and-conformance.md#value-encoding-cases)
- Tests and cases: [encoding tests](encoding_test.go), `corpus/*/value-encoding/` cases
- First check: `go -C impl/go test . -run 'Encoding|Decode|JSON'`

## Dispatch, scheduling and waits

- Implementation: [Host inputs, `Request` and `Pump`](group.go), [pending replies](group_pending.go), [`Group.Call` and Function Values](group_function.go), [Run scheduling](group_run.go), [Run cancellation](group_cancel_run.go), [message observation](group_observe.go), [sends](group_send.go)
- Rules: [scheduling](../../spec/05-handlers-messages-and-scheduling.md), [embedding](../../spec/09-embedding.md)
- Tests and cases: [error delivery](error_delivery_test.go), [waits](wait_test.go), [message waits](wait_for_test.go), [sends](send_wait_test.go), [queueing policies](policy_test.go), [Function calls](foreign_function_test.go)
- First check: `go -C impl/go test .`

## Capability Operations

- Implementation: [definitions and Grants](capability.go), [Shapes](shape.go), [Operation invocation](group_operation.go), [Host Crossings and resumes](group_crossing.go)
- Rules: [Capabilities and Shapes](../../spec/09-embedding.md#capabilities), [costs](../../spec/08-the-abstract-machine-and-the-cost-model.md)
- Tests and cases: [embedding tests](capability_test.go), [Capability cases](../../corpus/capabilities/)
- First check: `go -C impl/go test .`

## Capability Scopes, Segment-bound effects and Coordinators

- Implementation: [Scopes](group_scope.go), [participants and Coordinators](group_effect.go)
- Rules: [Scopes and Segment-bound effects](../../spec/09-embedding.md#capability-scopes-and-segment-bound-effects), [worked examples](../../spec/embedding/scoped-effects.md)
- Tests and cases: [Segment effect tests](segment_effect_test.go), [Scope tests](scope_test.go), [`effect-*` Capability cases](../../corpus/capabilities/)
- First check: `go -C impl/go test . -run 'Segment|Scope'`

## Script lifecycle and Grant release

- Implementation: [Stop](group_stop.go), [owner disposal](group_dispose.go), [Reload](script_reload.go), [release hooks](group_release.go), [revocation and Scopes](group_scope.go)
- Rules: [Cancellation and Stop](../../spec/06-errors-and-limits.md#cancellation-and-stop), [Reload](../../spec/10-save-and-restore.md#reload), [Grant release hooks](README.md#grant-release-hooks)
- Tests and cases: [release tests](grant_release_test.go), [Stop tests](stop_test.go), [Reload cases](../../corpus/reload/)
- First check: `go -C impl/go test . -run 'GrantRelease|Stop|Reload'`

## Zig backend

- Implementation: [adapter](zig_backend.go), [shared guests](zig_shared.go), [inline inputs](zig_inline.go), [reply decoding](zig_reply.go), [persistence bridge](zig_save.go), [Capability bridge](zig_capability.go), [guest ownership](internal/zigwasm/), [build/acceptance](adapter-check.sh)
- Rules: [embedding](../../spec/09-embedding.md), [supported slice and limits](README.md#zig-backend)
- Tests and cases: [public adapter acceptance](zig_backend_test.go), [Capability acceptance](zig_capability_test.go), [shared public Hosts](zig_capability_public_test.go), [Scope/Segment Hosts](zig_effect_public_test.go), [Standard factory Hosts](zig_standard_public_test.go), [persistence Hosts](zig_save_public_test.go) and [live-effect refusal](zig_save_test.go) plus unchanged public Go tests; `TestZigBackendCapabilityParity` diffs Zig against the native Go Core's recorded `TestCapabilityBridge` observations ([testdata](testdata/native-bridge-observations.json.gz)), kept from before its removal. To add a parity scenario, write a `run<Area>BridgeCases(t) []bridgeObservation` in a `zig_<area>_public_test.go` and append it in `runBridgeCases` ([`zig_capability_public_test.go`](zig_capability_public_test.go))
- Measurements: [Backend benchmarks](backend_bench_test.go), [Group instantiation](group_bench_test.go) and the Benchmark Suite; earlier comparisons with native Go are in [the binding research](../../docs/research/go-zig-binding.md)
- First check: `CGO_ENABLED=0 go -C impl/go test .`. The focused gate CI also runs: `CGO_ENABLED=0 impl/go/adapter-check.sh`. One test: `go -C impl/go test -run '^TestZigBackendCapabilityParity$' .`; cross-compile (also in CI): `impl/go/cross-check.sh`
- After changing the Zig Core: try it with the [hand swap](README.md#hand-swap) (`impl/go/hand-swap.sh`), then commit and refresh the embedded copy with `python3 impl/go/build-artifact.py`; the [Zig task map](../zig/NAVIGATION.md#after-changing-the-zig-core) lists every step

## Binary Request/Pump and combined calls

- Implementation: [binary exchange](zig_binary.go), [combined calls through the adapter](zig_combined.go), [combined Request and Pump](group_combined.go)
- Rules: [the binary exchange](../../spec/embedding/request-pump-binary.md), [ADR 0110](../../docs/adr/0110-request-and-pump-have-an-optional-binary-exchange.md), [measurements](../../docs/research/request-pump-binary.md)
- Tests and cases: [adapter tests](zig_combined_test.go), [public tests](group_combined_test.go), [benchmarks](group_combined_bench_test.go); `TALK_ZIG_REQUEST_PUMP=fields` runs the adapter suites on the binary exchange, as the [Go workflow](../../.github/workflows/go.yml) does; Host callbacks ([`zig_callback.go`](zig_callback.go)) are binary unless `TALK_ZIG_CALLBACKS=` is set empty
- Measurement reports: [paired ratios](cmd/request-pump-report/main.go), [tests](cmd/request-pump-report/main_test.go); first check: `go -C impl/go test ./cmd/request-pump-report`. For sample settings and acceptance claims, read the [measurement protocol](../../docs/research/request-pump-binary.md#measurement-protocol-1278).
- First check: `CGO_ENABLED=0 TALK_ZIG_REQUEST_PUMP=fields impl/go/adapter-check.sh`; envelope gates: `impl/go/request-pump-bench.sh`, also run by the [bench workflow](../../.github/workflows/go-zig-bench.yml)

## Public embedding API

- Implementation: [declarations](../../spec/embedding/talk.go) mirrored by the root package
- Rules: [Embedding](../../spec/09-embedding.md)
- Tests and cases: [API comparison](internal/apicheck/api_test.go): a root export absent from `talk.go`, or a signature that differs, fails; declare new exports there first. `bun tools/zig/api.ts` also requires each `talk.go` name to have its C declaration in [`talk.h`](../zig/include/talk.h), so add both in one PR, or keep an experimental API unexported
- First check: `go -C impl/go test ./internal/apicheck`

## Host Manifest

- Implementation: none: Go does not yet implement `ExportManifest`; `apicheck` logs it as declared but unimplemented
- Rules: [`ManifestSpec` and `ExportManifest`](../../spec/embedding/talk.go), [Host Manifest format](../../spec/09-embedding.md#the-host-manifest-format), [ADR 0028](../../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)
- Tests and cases: the Zig Core implements it ([Zig task map](../zig/NAVIGATION.md))
- First check: `go -C impl/go test ./internal/apicheck -v`

## Libraries and Standard Library

- Implementation: [compilation and registration](library.go), [normative sources](stdlib.go)
- Rules: [Libraries](../../spec/07-libraries-and-the-standard-library.md), [identity](../../spec/09-embedding.md#loading-and-libraries)
- Tests and cases: [public Library tests](library_test.go), [Library cases](../../corpus/libraries/), [stdlib cases](../../corpus/stdlib/)
- First check: `go -C impl/go test .`

## Save, restore and code updates

- Implementation: [snapshot DTOs](save.go), [rehydration](restore.go), [save-format version](core.go), [settlements](settle.go), [Extend](script_extend.go), [replacement](library_replace.go)
- Rules: [save and restore](../../spec/10-save-and-restore.md), [Fingerprint](../../spec/09-embedding.md#the-pump-and-the-group-fingerprint)
- Tests and cases: [snapshot tests](save_test.go), [extension tests](extend_test.go), [save/restore cases](../../corpus/save-restore/)
- First check: `go -C impl/go test .`

## Text Patterns

- Implementation: [values](internal/value/pattern.go), [program size](internal/valueops/pattern.go); matching is the Zig Core's
- Rules: [Text Pattern programs](../../spec/08-the-abstract-machine-and-the-cost-model.md#text-pattern-programs)
- Tests and cases: [public acceptance](pattern_test.go), [pattern cases](../../corpus/text-patterns/)
- First check: `go -C impl/go test .`

## Generated tables

- Implementation: [Go generator](../../tools/go/generate.ts), [Unicode generator](../../tools/unicode/generate.ts), [syntax generator](../../tools/syntax/generate.ts) → [tables](internal/generated/)
- Rules: [Data Files](../../spec/README.md#data-files)
- Tests and cases: [generator tests](../../tools/go/generate.test.ts), [Cost Model compiler tests](../../tools/costs/compile.test.ts), [Unicode tests](internal/unicode/unicode_test.go)
- First check: `bun run go:check`

## Sessions, REPL and Transcripts

- Implementation: [Host](session/host.go), [analysis bridge](internal/analysis/) (negotiated Zig `analysis-v1`, via [the guest](zig_analysis.go)), [Session Commands](session/commands.go), [observation](session/observe.go), [`:describe`](session/describe.go), [inspection](session/inspect.go), [drivers](driver/), [Transcript replay](driver/transcript.go), [CLI](cmd/northtalk/)
- Rules: [Entries](../../spec/02-grammar.md#entries), [sessions](../../spec/12-sessions-and-tooling.md), [Session observation](../../spec/session-observation.md)
- Tests and cases: [Host tests](session/host_test.go), [REPL tests](driver/repl_test.go), [Session parity](internal/corpus/session_test.go), [Transcripts](../../corpus/sessions/)
- First check: `go -C impl/go test ./session ./driver`

## HTTP router

- Implementation: [`httphost`](httphost/host.go), on `net/http`
- Rules: [The HTTP router](../../spec/09-embedding.md#the-http-router), [HTTP Exchanges](../../spec/07-libraries-and-the-standard-library.md#http-exchanges)
- Tests and cases: [http kit](../../corpus/http-kit/) and [its runner](httphost/kit_test.go)
- First check: `go -C impl/go test -race ./httphost`

## Notification router

- Implementation: [router](notify/router.go), [`ScriptNames`](group.go), [Grant accessors](capability.go)
- Rules: [Store Notifications](../../spec/09-embedding.md#the-notification-router), [ADR 0061](../../docs/adr/0061-host-notifications-share-routing-and-are-scoped-by-grant-bindings.md)
- Tests and cases: [router kit](../../corpus/notify-kit/) and [its runner](notify/kit_test.go), [real-Group tests](notify/router_test.go)
- First check: `go -C impl/go test -race ./notify`

## Driver Pool and the multi-tenant Example Host

- Implementation: [Pool](driver/pool.go), [Example Host](examples/tenants/)
- Rules: [Threads and the input queue](../../spec/09-embedding.md#threads-and-the-input-queue), [Example Hosts](../../spec/appendix-b-implementation-order.md#milestone-2-the-example-hosts)
- Tests and cases: [Pool tests](driver/pool_test.go), [Host tests](examples/tenants/tenants_test.go), [`tenants-*` cases](../../corpus/examples/)
- First check: `go -C impl/go test -race ./driver ./examples/tenants`

## Corpus selection and parity

- Implementation: [runner](internal/corpus/runner.go), [passing gate](corpus-passing.txt); the Zig Core's own runner checks Disassembly cases
- Rules: [corpus commands and blessing](../../corpus/README.md#checking), [adding a case](../../corpus/README.md#adding-a-case), [conformance](../../spec/11-the-trace-and-conformance.md)
- Tests and cases: [runner tests](internal/corpus/corpus_test.go), [execution backends](internal/corpus/execution_test.go)
- First check: `go -C impl/go test ./internal/corpus`; one case: `NORTHTALK_CORPUS=<case> go -C impl/go test ./internal/corpus -run TestSelectedCases`

The [implementation guide](README.md) describes the supported subset and its limits. Follow Spec links for rules and the [ADR index](../../docs/adr/README.md) for rationale. The TS Core is a parity peer; root `tools/grammar/` and `tools/machine/` are Spec-checking prototypes. Update generated files through their generators.

Packages outside the root reach Group internals through hooks: a root `*_hooks.go`
file ([replay_hooks.go](replay_hooks.go), [documentation_hooks.go](documentation_hooks.go),
[session_io_hooks.go](session_io_hooks.go))
assigns function variables in an `internal/` package from `init`, and `session/`
calls them. Fixtures both Cores read, such as Declaration Documentation, live in
[impl/testdata/](../testdata/). `CoreVersions` reports the embedded guest's
versions, so a save-format change is the Zig Core's
([Zig task map](../zig/NAVIGATION.md)). Add corpus cases as
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

The optional `http` factory lives in [http_capability.go](http_capability.go),
with its corpus runner Stubs in [internal/corpus/operations.go](internal/corpus/operations.go);
the embedded Zig Core makes its checks. Check it with `go -C impl/go test . -run HTTP`
and the `standard-http*` Capability cases.

The native Message Layer sidecar and WASI reactor now live in the [Zig task map](../zig/NAVIGATION.md). The Go public embedding API remains here.
