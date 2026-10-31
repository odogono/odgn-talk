# TS and tooling task navigation

Find your task's heading (`rg -n '^## ' impl/ts/NAVIGATION.md` lists them), then read the linked rules and tests. Read the
[implementation guide](README.md) when you need feature details or limitations.
List paths with `rg --files` in the relevant directory before opening files by
name. For domain terms, use [GLOSSARY.md](../../GLOSSARY.md); for rationale, use the
[ADR index](../../docs/adr/README.md).

All commands below run from the repository root; `lint`, `format:check` and
`check` exist only as root scripts. To measure a change against `origin/main`, run `bun run bench:compare [--filter <text>] [--node]`; to find hot spots, `bun run bench:profile <filter>` ([comparing](../../bench/README.md#comparing-a-branch-with-main), [profiling](../../bench/README.md#profiling)). See the
[Spec change-impact guide](../../docs/agents/spec-changes.md) when changing Data
Files, grammar, or lowering.

## Parsing and name/binding checks

- Implementation: [parser](src/parser.ts), [syntax tree](src/syntax.ts), [Selectors](src/selectors.ts), [checker](src/checker.ts)
- Rules: [grammar](../../spec/02-grammar.md)
- Tests and cases: [parser tests](tests/parser.test.ts), [checker tests](tests/checker.test.ts)
- First check: `bun test impl/ts/tests/parser.test.ts impl/ts/tests/checker.test.ts`

## Lowering and execution

- Implementation: [lowering](src/lowering.ts), [machine](src/machine.ts)
- Rules: [Abstract Machine and costs](../../spec/08-the-abstract-machine-and-the-cost-model.md)
- Tests and cases: [lowering tests](tests/lowering.test.ts), [disassembly cases](../../corpus/disassembly/)
- First check: `bun test impl/ts/tests/lowering.test.ts`

## Built-ins and instruction charging

- Implementation: `builtin` and its measures in [operations.ts](src/operations.ts), instruction payment in [machine.ts](src/machine.ts), generated evaluators in [costs.ts](src/costs.ts)
- Rules: [charging](../../spec/08-the-abstract-machine-and-the-cost-model.md#charging), [Built-in rates](../../spec/08-the-abstract-machine-and-the-cost-model.md#built-in-rates), [cost data](../../spec/data/costs.toml)
- Tests and cases: [Cost Model parity tests](tests/costs.test.ts), [Built-in cases](../../corpus/builtins/), [lowering tests](tests/lowering.test.ts)
- First check: `bun test impl/ts/tests/costs.test.ts && bun run corpus:run builtins`
- Stdlib Fuel: a stdlib edit that changes [the generated snapshot](../../tools/costs/stdlib-fuel.txt) changes the Cost Model. Regenerate it with `bun run stdlib-fuel:generate`, call the change out in the PR, and decide whether `costs.toml` needs a `[[change]]` entry.

## Recovery, cancellation cleanup and retained state

- Implementation: `Run.size` in [machine.ts](src/machine.ts), [recovery state](src/recovery.ts)
- Rules: [pending cleanup state](../../spec/08-the-abstract-machine-and-the-cost-model.md#pending-cleanup-state)
- Tests and cases: [cancellation state tests](tests/recovery-cancellation-state.test.ts), [nested accounting tests](tests/recovery-nested-accounting.test.ts), [snapshot tests](tests/recovery-snapshot.test.ts), [Recovery Offer cases](../../corpus/recovery-offers/)
- First check: `bun test impl/ts/tests/recovery-cancellation-state.test.ts impl/ts/tests/recovery-nested-accounting.test.ts impl/ts/tests/recovery-snapshot.test.ts`

## Values and collections

- Implementation: [values](src/values.ts), [List storage](src/list-storage.ts), [Map storage](src/map-storage.ts), code-point ordering in `compareText` ([text.ts](src/text.ts))
- Rules: [Lists and maps](../../spec/03-values.md#lists-and-maps), [costs](../../spec/08-the-abstract-machine-and-the-cost-model.md)
- Tests and cases: [value tests](tests/values.test.ts), [persistent collection tests](tests/persistent-collections.test.ts)
- First check: `bun test impl/ts/tests/values.test.ts impl/ts/tests/persistent-collections.test.ts`

## Value Encoding

- Implementation: [`encodeValue`](src/encoding.ts), [`decodeValue`](src/readers.ts)
- Rules: [JSON and the Value Encoding](../../spec/09-embedding.md#json-and-the-value-encoding), [encoding cases](../../spec/11-the-trace-and-conformance.md#value-encoding-cases)
- Tests and cases: [value tests](tests/values.test.ts), `corpus/*/value-encoding/` cases
- First check: `bun test impl/ts/tests/values.test.ts`

## Scheduling and Capabilities

- Implementation: [Group](src/group.ts), [Capabilities](src/capabilities.ts)
- Rules: [scheduling](../../spec/05-handlers-messages-and-scheduling.md), [embedding](../../spec/09-embedding.md)
- Tests and cases: [Group tests](tests/group.test.ts), [Capability tests](tests/capabilities.test.ts), [Scope tests](tests/scopes.test.ts)
- First check: `bun test impl/ts/tests/group.test.ts impl/ts/tests/capabilities.test.ts`

## Waits, suspending Calls and their abandonment

- Implementation: [the Wait table](src/waits.ts) (pending calls and replies, timers and their order, `wait for` waiters, Join settlement and cuts, abandonment with a reason, the awaited-call query, and save export/import), [Group](src/group.ts) (`suspended`, `settleReply`, `fireTimer`, `forgetWait`: scheduling and Trace writes), [Run](src/machine.ts) (`pendingCall`, `discard`, `abandonJoin`: the Run's own suspension and open Join). The ownership boundary follows [ADR 0105](../../docs/adr/0105-each-core-keeps-its-waits-in-one-wait-table-module.md).
- Rules: [Suspension Points](../../spec/05-handlers-messages-and-scheduling.md#suspension-points)
- Tests and cases: [Wait table tests](tests/waits.test.ts), [Group tests](tests/group.test.ts), [Capability tests](tests/capabilities.test.ts)
- First check: `bun test impl/ts/tests/waits.test.ts impl/ts/tests/group.test.ts`

## Capability Scopes, Segment-bound effects and Coordinators

- Implementation: [Segment participant policy](src/segment-participant.ts), [Run enrollment and Scopes](src/machine.ts), [Scope declarations and Coordinator mapping](src/capabilities.ts)
- Rules: [Scopes and Segment-bound effects](../../spec/09-embedding.md#capability-scopes-and-segment-bound-effects), [worked examples](../../spec/embedding/scoped-effects.md)
- Tests and cases: [Segment effect tests](tests/segment-effects.test.ts), [Coordinator tests](tests/segment-coordinators.test.ts), [Scope conformance](tests/scoped-conformance.test.ts), [`effect-*` Capability cases](../../corpus/capabilities/)
- First check: `bun test impl/ts/tests/segment-effects.test.ts impl/ts/tests/segment-coordinators.test.ts`

## Script lifecycle and Grant release

- Implementation: Stop, revocation and Reload in [Group](src/group.ts), Run teardown in [machine](src/machine.ts)
- Rules: [Cancellation and Stop](../../spec/06-errors-and-limits.md#cancellation-and-stop), [Reload](../../spec/10-save-and-restore.md#reload), [Grant release hooks](README.md#grant-release-hooks)
- Tests and cases: [release tests](tests/grant-release.test.ts), [Reload tests](tests/reload.test.ts), [cancellation tests](tests/cancellation.test.ts), [Reload cases](../../corpus/reload/)
- First check: `bun test impl/ts/tests/grant-release.test.ts impl/ts/tests/reload.test.ts`

## Public embedding API

- Implementation: [declarations](../../spec/embedding/talk.ts); the `Core`, `Group` and `Script` interfaces both Cores implement in [embedding.ts](src/embedding.ts) ([ADR 0121](../../docs/adr/0121-ts-host-code-types-against-one-embedding-interface.md)), exported from [index.ts](src/index.ts) and [wasm/index.ts](src/wasm/index.ts)
- Rules: [Embedding](../../spec/09-embedding.md), [Public values](README.md#public-values)
- Tests and cases: [the API comparison](tests/embedding-api.test.ts) holds `embedding.ts` and the driver to `talk.ts`, as the [Go one](../go/internal/apicheck/api_test.go) does for `talk.go`, and fails when `index.ts` gains an export `wasm/index.ts` lacks, unless its TS-only list names it
- Combined admission/Pump: [native/WASM parity tests](tests/combined.test.ts); transferable codecs in [message-layer.ts](src/message-layer.ts), [Value tests](tests/binary-value.test.ts) and [frame tests](tests/request-pump-binary.test.ts). Browser interoperability: `bun impl/ts/tools/request-pump-browser.ts`.
- First check: `bun run typecheck && bun test impl/ts/tests/embedding-api.test.ts`

## The Zig reactor behind the embedding API

- Implementation: [`@northtalk/ts/wasm`](src/wasm/index.ts): the [Group](src/wasm/group.ts) and its needs, the [guest conversation](src/wasm/session.ts), [Values crossing](src/wasm/codec.ts), [frames](src/wasm/wire.ts) and the [WASI imports](src/wasm/reactor.ts)
- Rules: [the message layer](../../spec/09-embedding.md#the-message-layer), [paused inputs](../../spec/embedding/paused-crossing-inputs.md), [ADR 0097](../../docs/adr/0097-browser-hosts-may-run-the-zig-reactor-through-the-ts-embedding-api.md), [the guide's differences](README.md#the-zig-reactor-in-a-browser)
- Tests and cases: [parity tests](tests/wasm.test.ts), [core-switch example](examples/core-switch/), [Corpus replay](tools/wasm-corpus.ts), [browser figures](tools/wasm-browser.ts)
- First check: `bun run wasm:build && bun test impl/ts/tests/wasm.test.ts && bun impl/ts/tools/wasm-corpus.ts --quiet`
- Nothing rebuilds `.cache/zig-wasi/bin/talk.wasm`: after pulling or rebasing onto Zig changes, run `bun run wasm:build` again before trusting a WASM failure. The tests warn when it is missing or older than the Zig sources ([the shared lookup](tests/reactor-artifact.ts)).

## Host Manifest export

- Implementation: `exportManifest` and Operation data in [manifest.ts](src/manifest.ts), exported from [index.ts](src/index.ts)
- Rules: [Host Manifest format](../../spec/09-embedding.md#the-host-manifest-format)
- Tests and cases: [Manifest tests](tests/manifest.test.ts)
- First check: `bun test impl/ts/tests/manifest.test.ts`

## Stores

- Implementation: [`store` factory and `add`](src/store-capability.ts), [Store engine and backends](src/store/), [SQLite Store](src/sqlite/database.ts) and [its example](examples/store-sqlite/)
- Rules: [`store`](../../spec/07-libraries-and-the-standard-library.md#store), [ADR 0062](../../docs/adr/0062-a-store-key-is-reserved-while-a-segment-holds-an-uncommitted-write.md)
- Tests and cases: [store tests](tests/store.test.ts), [store test kit](../../corpus/store-kit/) and [its runner](tools/store-kit.ts), [Session Store tests](tests/session-store.test.ts)
- First check: `bun test impl/ts/tests/store.test.ts impl/ts/tests/store-kit.test.ts`

## `sqlite`

- Implementation: [`sqlite` factory and conversions](src/sqlite-capability.ts), [`node:sqlite` implementation and its Stores](src/sqlite/), [corpus runner Stubs](src/replay.ts)
- Rules: [`sqlite`](../../spec/07-libraries-and-the-standard-library.md#sqlite), [the factory](../../spec/09-embedding.md#the-sqlite-factory), [Stubs](../../spec/11-the-trace-and-conformance.md#stubs)
- Tests and cases: [factory tests](tests/sqlite-capability.test.ts), [`standard-sqlite*` cases](../../corpus/capabilities/), [sqlite test kit](../../corpus/sqlite-kit/) and [its runner](tools/sqlite-kit.ts), [Group tests](tests/sqlite-host.test.ts), [Node runs](tests/sqlite-runtimes.test.ts)
- First check: `bun test impl/ts/tests/sqlite-capability.test.ts impl/ts/tests/sqlite-kit.test.ts`

## `user`

- Implementation: [`user` factory and `choose` answer rule](src/user-capability.ts), [corpus runner Stubs](src/replay.ts)
- Rules: [`user`](../../spec/07-libraries-and-the-standard-library.md#user), [the factory](../../spec/09-embedding.md#the-user-factory)
- Tests and cases: [factory tests](tests/user-capability.test.ts), [`standard-user*` cases](../../corpus/capabilities/)
- First check: `bun test impl/ts/tests/user-capability.test.ts`

## `http`

- Implementation: [`http` factory, `invalid serve` and `invalid response` checks](src/http-capability.ts), [`fetch`'s request checks, URL normalization and answer checks](src/http-fetch.ts), [corpus runner Stubs](src/replay.ts)
- Rules: [`http`](../../spec/07-libraries-and-the-standard-library.md#http), [the factory](../../spec/09-embedding.md#the-http-factory)
- Tests and cases: [factory tests](tests/http-capability.test.ts), [`standard-http*` cases](../../corpus/capabilities/), including `standard-http-fetch*`, which the Zig reactor can't run until #1869 (`known` in [the WASM Corpus runner](tools/wasm-corpus.ts))
- First check: `bun test impl/ts/tests/http-capability.test.ts && bun run corpus:run capabilities/standard-http`

## HTTP router

- Implementation: [`@northtalk/ts/http`](src/http/router.ts), on `node:http`; [the `fetch` client](src/http/fetch.ts), on `node:http` and `node:https`
- Rules: [The HTTP router](../../spec/09-embedding.md#the-http-router), [HTTP Exchanges](../../spec/07-libraries-and-the-standard-library.md#http-exchanges), [Fetching](../../spec/07-libraries-and-the-standard-library.md#fetching)
- Tests and cases: [http kit](../../corpus/http-kit/) and [its runner](tools/http-kit.ts), [kit tests](tests/http-kit.test.ts), [Node runs](tests/http-runtimes.test.ts) of the kit and of [the fetch checks](tools/http-fetch-runtime.ts), [lifecycle tests](tests/http-host.test.ts), [fetch tests](tests/http-fetch-host.test.ts) against local HTTP and [TLS fixtures](tests/fixtures/http-tls/)
- First check: `bun test impl/ts/tests/http-kit.test.ts impl/ts/tests/http-host.test.ts impl/ts/tests/http-fetch-host.test.ts`

## Notification router

- Implementation: [router](src/notify/router.ts), [`Group.scriptNames`](src/group.ts)
- Rules: [Store Notifications](../../spec/09-embedding.md#the-notification-router), [ADR 0061](../../docs/adr/0061-host-notifications-share-routing-and-are-scoped-by-grant-bindings.md)
- Tests and cases: [router kit](../../corpus/notify-kit/) and [its runner](tools/notify-kit.ts), [kit tests](tests/notify-kit.test.ts), [Node runs](tests/notify-runtimes.test.ts), [real-Group tests](tests/notify.test.ts)
- First check: `bun test impl/ts/tests/notify-kit.test.ts impl/ts/tests/notify.test.ts`

## Real file cleanup and publication

- Implementation: [File Example Host](examples/files/)
- Rules: [file lifecycle examples](../../spec/embedding/scoped-effects.md#file-handle-cleanup)
- Tests and cases: [Temporary-file integration tests](examples/files/files.test.ts)
- First check: `bun test impl/ts/examples/files/files.test.ts`

## `autoDrive` and the webhook rules Example Host

- Implementation: [driver](src/driver.ts), [Example Host](examples/webhooks/)
- Rules: [Threads and the input queue](../../spec/09-embedding.md#threads-and-the-input-queue), [Example Hosts](../../spec/appendix-b-implementation-order.md#milestone-2-the-example-hosts)
- Tests and cases: [driver tests](tests/driver.test.ts), [Host and server tests](examples/webhooks/webhooks.test.ts), [`webhooks` case](../../corpus/examples/webhooks/)
- First check: `bun test impl/ts/tests/driver.test.ts impl/ts/examples/webhooks`

## `createGroup`, Handler and inline Grant Helpers

- Implementation: [shared Group Helper](src/group-helper.ts) (used by `/wasm`), [root wrapper with the default TS Core](src/create-group.ts), [plain-JS Handler calls](src/handlers.ts), [inline Grants](src/inline-grants.ts)
- Rules: [Driving a TS Group](../../spec/09-embedding.md#driving-a-ts-group), [ADR 0130](../../docs/adr/0130-ts-helpers-convert-plain-js-at-the-boundary.md)
- Tests and cases: [`createGroup` tests](tests/create-group.test.ts), [Handler Helper tests](tests/handlers.test.ts), [inline Grant tests](tests/inline-grants.test.ts), [embedding interface test](tests/embedding-api.test.ts)
- First check: `bun test impl/ts/tests/create-group.test.ts impl/ts/tests/handlers.test.ts impl/ts/tests/inline-grants.test.ts`

## Save and restore

- Implementation: the shared binary format of [ADR 0144](../../docs/adr/0144-a-save-restores-on-either-core.md). [group-snapshot.ts](src/group-snapshot.ts) writes the Group's sections; [save-file.ts](src/save-file.ts) reads and writes a whole save's records: the section order, the tables later sections index, and every check that needs only the bytes (`openSave` is a restore's first pass, `values` its second, and `readRecords`/`writeRecords` serve tests and tools); [save-runs.ts](src/save-runs.ts) converts a Run to its `run` record and back; [save-state.ts](src/save-state.ts) writes values and code positions, and [save-values.ts](src/save-values.ts) reads them; [save-records.ts](src/save-records.ts) is every record's bytes; [save-format.ts](src/save-format.ts) the primitives, frames and digests, on the incremental `Sha256` in [sha256.ts](src/sha256.ts); [save-marks.ts](src/save-marks.ts) the bookkeeping only a save reads. [Group](src/group.ts) refuses a save, writes its Trace and rebuilds on restore (`readState`, `applyState`). The boundary follows [ADR 0122](../../docs/adr/0122-the-ts-core-keeps-its-save-format-in-one-module.md).
- Comparing with Zig: `bun impl/ts/tools/save-compare.ts [--no-restore] [--cross] [--show] case …` replays cases on both Cores and diffs each save record by record; `--cross` restores each Core's saves on the other. The cross-Core replay, [cross-core.ts](tools/cross-core.ts) (`bun run corpus:cross`), is the check CI runs. Tests edit saves through [save-edit.ts](tests/save-edit.ts).
- Partial Restore ([ADR 0143](../../docs/adr/0143-a-restore-may-reload-only-the-scripts-whose-code-changed.md)): `Group.restore` in [group.ts](src/group.ts) builds the `changed` set of Scripts whose code differs and fills `reloaded`; their Runs are read only to be discarded, and `reloadRestored` keeps their mailbox under `keepMailbox`, which `mailboxSize` counts toward the cap; the corpus's `> replace-library` input is in [replay.ts](src/replay.ts).
- Tests and cases: [save/restore tests](tests/save-restore.test.ts), [Partial Restore tests](tests/partial-restore.test.ts), [Partial Restore cases](../../corpus/save-restore/) (`partial-restore-*`)
- First check: `bun test impl/ts/tests/save-restore.test.ts`

## Sessions, Transcripts and CLI

- Implementation: [Setup and Group construction](src/setup.ts), [Session Host](src/session/host.ts), [observation](src/session/observe.ts), [`:describe`](src/session/describe.ts), [inspection](src/session/inspect.ts), [Transcript codec/replay](src/session/transcript.ts), [Session Driver](../../tooling/stack/src/session-driver.ts), [worker supervisor](../../tooling/stack/src/worker-supervisor.ts), [CLI](../../tooling/cli/)
- Rules: [sessions and tooling](../../spec/12-sessions-and-tooling.md), [Session observation](../../spec/session-observation.md)
- Tests and cases: [Session tests](tests/session.test.ts), [Transcript tests](tests/transcript.test.ts), [Session Driver tests](../../tooling/stack/tests/session-driver.test.ts), [worker supervisor tests](../../tooling/stack/tests/worker-supervisor.test.ts), [Session corpus](../../corpus/sessions/)
- First check: `bun test impl/ts/tests/session.test.ts impl/ts/tests/transcript.test.ts`
- Save diff: [`diff-save` and `dump-save`](../../tooling/stack/src/save-diff.ts) decode saves through the generated schema copy that `bun run lints:generate` writes from [save-format.toml](../../spec/data/save-format.toml); `bun test tooling/stack/tests/save-diff.test.ts`

## Formatting source

- Implementation: [Tooling formatter](../../tooling/stack/src/format.ts), [CLI](../../tooling/cli/src/format.ts)
- Rules: [formatter](../../spec/12-sessions-and-tooling.md#the-formatter)
- Tests and cases: [Formatter tests and invariants](../../tooling/stack/tests/), [CLI tests](../../tooling/cli/tests/)
- First check: `bun test tooling/stack/tests/format.test.ts`

## Lints and CLI advice

- Implementation: [Lint engine](../../tooling/stack/), [CLI](../../tooling/cli/)
- Rules: [Layers and Lints](../../spec/12-sessions-and-tooling.md#layers-and-lints)
- Tests and cases: [Lint fixtures](../../tooling/stack/tests/lint.test.ts), [CLI tests](../../tooling/cli/tests/cli.test.ts)
- First check: `bun test tooling/stack/tests/lint.test.ts`

## Editor language server

- Implementation: [LSP entry](../../tooling/stack/src/lsp.ts), [features](../../tooling/stack/src/lsp/features.ts), [workspace analysis](../../tooling/stack/src/lsp/workspace.ts), [senders and implementors](../../tooling/stack/src/lsp/messages.ts), [Manifest](../../tooling/stack/src/lsp/manifest.ts), [Operation dictionary](../../tooling/stack/src/dictionary.ts), [stdio CLI](../../tooling/cli/src/lsp.ts)
- Rules: [LSP](../../spec/12-sessions-and-tooling.md#the-lsp), [Host Manifest](../../spec/09-embedding.md#the-host-manifest-format)
- Tests and cases: [Language-feature tests](../../tooling/stack/tests/lsp.test.ts), [stdio fixture workspace](../../tooling/cli/tests/lsp-runtime.test.ts)
- First check: `bun test tooling/stack/tests/lsp.test.ts`

## VS Code and Cursor extension

- Implementation: [grammar generator](../../tooling/vscode/tools/grammar.ts) → [TextMate grammar](../../tooling/vscode/syntaxes/northtalk.tmLanguage.json), [LSP client](../../tooling/vscode/src/extension.ts)
- Rules: [extension guide](../../tooling/vscode/README.md), [LSP](../../spec/12-sessions-and-tooling.md#the-lsp)
- Tests and cases: [grammar tests](../../tooling/vscode/tests/grammar.test.ts)
- First check: `bun test tooling/vscode/tests`

## Running a Script file

- Implementation: [Script Runner](../../tooling/cli/src/run.ts), dispatched from [the CLI](../../tooling/cli/src/main.ts), over [`newDrivenGroup`](src/driver.ts) and [the HTTP router](src/http/router.ts)
- Rules: [The Script Runner](../../spec/12-sessions-and-tooling.md#the-script-runner), [ADR 0126](../../docs/adr/0126-a-northtalk-command-given-a-file-runs-it-as-a-script-runner.md), [CLI guide](../../tooling/cli/README.md#running-a-script)
- Tests and cases: [Runner checks shared by Bun and Node](../../tooling/cli/tests/run-integration.ts), [the HTTP example](../../examples/http/hello.talk)
- First check: `bun test tooling/cli/tests/run-runtime.test.ts`

## Testing user Scripts

- Implementation: [Test runner](../../tooling/cli/src/test.ts) over the public Group API
- Rules: [Testing Scripts](../../tooling/cli/README.md#testing-scripts), [ADR 0056](../../docs/adr/0056-user-scripts-are-tested-by-a-black-box-test-script.md)
- Tests and cases: [CLI tests](../../tooling/cli/tests/cli.test.ts)
- First check: `bun test tooling/cli/tests/cli.test.ts`

## Live debugging

- Implementation: [Tooling API](../../tooling/stack/src/debug.ts), [Bun CLI](../../tooling/cli/src/debug.ts)
- Rules: [Debugger](../../spec/12-sessions-and-tooling.md#the-debugger), [Core hooks](README.md#tooling-debug-hooks)
- Tests and cases: [Live debugger tests](../../tooling/stack/tests/debug.test.ts), [Trace parity](../../tooling/stack/tests/debug-corpus.test.ts), [CLI tests](../../tooling/cli/tests/debug.test.ts)
- First check: `bun test tooling/stack/tests/debug.test.ts`

## Trace replay debugging

- Implementation: [Shared replay driver](src/replay.ts), [Tooling API](../../tooling/stack/src/debug.ts), [Bun CLI](../../tooling/cli/src/debug-replay.ts)
- Rules: [Debugger](../../spec/12-sessions-and-tooling.md#the-debugger), [Stubs](../../spec/11-the-trace-and-conformance.md#stubs)
- Tests and cases: [Navigation tests](../../tooling/stack/tests/replay-debug.test.ts), [Trace and Transcript parity](../../tooling/stack/tests/replay-debug-corpus.test.ts)
- First check: `bun test tooling/stack/tests/replay-debug.test.ts`

## northtalk.org (`tooling/site`)

- Implementation: [published files](../../tooling/site/src/sources.ts), [link rewriting](../../tooling/site/src/rewrite.ts), [Starlight config](../../tooling/site/astro.config.mjs), [Worker](../../tooling/site/src/worker.ts)
- Rules: [site guide](../../tooling/site/README.md), [ADR 0140](../../docs/adr/0140-northtalk-org-is-one-cloudflare-worker-deployed-from-ci.md)
- Tests and cases: [rewrite tests](../../tooling/site/tests/rewrite.test.ts); `bun run --cwd tooling/site build` fails on a broken link
- First check: `bun test tooling/site/tests`

## Folio (`tooling/creative`)

- Implementation: [Folio task map](../../tooling/creative/NAVIGATION.md): Play Session, Project model, assets, Message Box, windows, Host Manifests, offline; on the [shared editor](../../tooling/editor/src/editor.ts) and its [LSP worker](../../tooling/editor/src/lsp.worker.ts)
- Rules: [Folio guide](../../tooling/creative/README.md), [#154](https://github.com/odogono/odgn-talk/issues/154), [ADR 0041](../../docs/adr/0041-authored-projects-are-separate-from-temporary-play-state.md)
- Tests and cases: [editor tests](../../tooling/editor/tests/), [Folio tests](../../tooling/creative/tests/), [browser suites](../../tooling/creative/README.md#browser-test-suites)
- First check: `bun test tooling/editor/tests tooling/creative/tests`

Folio's [build instructions](../../tooling/creative/NAVIGATION.md#running-and-testing)
cover its Preact JSX configuration and the app and browser-test bundles.

## Differential fuzzing

- Implementation: [Fuzzer](../../tooling/fuzz/) over the [shared replay driver](src/replay.ts), with the [Zig worker](../zig/src/corpus/fuzzworker.zig)
- Rules: [ADR 0009](../../docs/adr/0009-twin-cores-held-to-bit-for-bit-parity.md), [research](../../docs/research/differential-fuzzing.md)
- Tests and cases: [Fuzzer tests](../../tooling/fuzz/tests/), [replay Host tests](tests/replay-host.test.ts)
- First check: `bun test tooling/fuzz/tests`

## Benchmark page and Payload

- Implementation: [page renderer](../../bench/ts/src/html.ts), [report](../../bench/ts/src/report.ts), [Payload measurement](tools/payload.ts), [workflow](../../.github/workflows/bench-page.yml)
- Rules: [ADR 0054](../../docs/adr/0054-benchmarks-live-outside-the-cores-and-only-advise-the-cost-model.md), [the benchmark page](../../bench/README.md#the-benchmark-page)
- Tests and cases: [page tests](../../bench/ts/tests/html.test.ts), [Payload tests](tests/payload.test.ts)
- First check: `bun test bench/ts/tests impl/ts/tests/payload.test.ts`

## Generated tables

- Implementation: [syntax generator](../../tools/syntax/generate.ts), [Unicode generator](../../tools/unicode/generate.ts) → [generated TS](src/generated/)
- Rules: [Data File index](../../spec/README.md#data-files)
- Tests and cases: [syntax fixtures](tests/syntax-fixtures.test.ts), [Cost Model compiler tests](../../tools/costs/compile.test.ts), [Unicode tests](tests/unicode.test.ts)
- First check: `bun run syntax:check`

The parsers and compiler under root `tools/` check the Spec; the Core implementation is under `impl/ts/src/`. Follow the table's Spec links for rules and each chapter's ADR links for rationale. Generated tables are updated through their generators.

Multiline Entry collection, input while the session sleeps and wake scheduling live in the [Session Driver](../../tooling/stack/src/session-driver.ts), used by [CLI repl.ts](../../tooling/cli/src/repl.ts); editor highlighting lives in the [shared editor's language.ts](../../tooling/editor/src/language.ts). Corpus selection lives in [tools/corpus.ts](tools/corpus.ts), with Trace execution in [tools/trace-case.ts](tools/trace-case.ts) and Transcript execution in [tools/transcript-case.ts](tools/transcript-case.ts); use `bun run corpus:run sessions` for the Session cases. A new corpus case must also pass the Go gate; follow [the corpus guide](../../corpus/README.md#adding-a-case). Fixtures both Cores read, such as Declaration Documentation, live in [impl/testdata/](../testdata/).

These checks start the feedback loop; use the implementation guide and CI workflows for broader validation before completing a change.
