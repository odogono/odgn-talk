# Zig task navigation

Find your task's heading (`rg -n '^## ' impl/zig/NAVIGATION.md` lists them), then read the linked rules and tests. Read the
[implementation guide](README.md) for build details, and the
[decisions on #625](https://github.com/odogono/odgn-talk/issues/625#issuecomment-6111271797)
before changing anything they settle. For domain terms, use
[GLOSSARY.md](../../GLOSSARY.md); for rationale, use the
[ADR index](../../docs/adr/README.md).

Commands below run from the repository root; Zig commands change to `impl/zig/` first. For runner selectors, replay modes and backends, use the
[corpus command guide](../../corpus/README.md#checking). Read the Go and TS Cores for
nothing but the cases they blessed: the Zig Core is written from the Spec.
A passing test's `std.debug.print` output shows only on the run that executes
it; cached reruns print nothing, so save the first `zig build test 2>&1` to a file.

Unit tests run with `cd impl/zig && zig build test`, which has no
`-Dtest-filter` option. To run one test, call the compiler directly:

```sh
cd impl/zig && zig test -ODebug --dep talk.h --dep inspect-reader -Mroot=src/root.zig \
  -Mtalk.h=include/talk.h -Minspect-reader=../../spec/session/inspect-reader.talk \
  --test-filter '<test name>'
```

To measure a change, run `bun run bench --only zig --count 5 --no-save
[--filter <text>]` on `origin/main` and on the branch, alternating; runs vary
by ±5–8%. A detached baseline worktree comes from
`git worktree add --detach <dir> origin/main`, since the local `main` may be
behind. For the WASI embedding itself (Pump and Capability exchanges, startup,
memory), use the [Message Layer C Host](../../bench/message-layer-c/README.md);
`impl/go/request-pump-bench.sh` compares against a pinned `BASE`, not `main`.

A new module's tests run only once the `test` block in
[`root.zig`](src/root.zig) references it (`_ = binary_value;`).
`message.zig` and `machine/machine.zig` run to thousands of lines; find a
section by its function (`rg -n 'fn handleFrame' impl/zig/src/message.zig`)
rather than paging through.

After a Zig change, see [what consumes the Core](#after-changing-the-zig-core).

## UTF-8 and Host text

- Implementation: [UTF-8](src/unicode/utf8.zig), [C API](src/talk.zig), [`talk.h`](include/talk.h)
- Rules: [source text](../../spec/01-lexical-structure.md#source-text), [Text](../../spec/03-values.md#text)
- Tests and cases: [C Host tests](tests/talk_h_test.c), tests in each file
- First check: `cd impl/zig && zig build test`

## NFC

- Implementation: [normalisation](src/unicode/normalize.zig)
- Rules: [Unicode](../../spec/01-lexical-structure.md#unicode), [Text](../../spec/03-values.md#text)
- Tests and cases: [conformance tests](src/unicode/conformance_test.zig)
- First check: `cd impl/zig && zig build test`

## Characters

- Implementation: [grapheme clusters](src/unicode/grapheme.zig)
- Rules: [Text](../../spec/03-values.md#text)
- Tests and cases: [conformance tests](src/unicode/conformance_test.zig)
- First check: `cd impl/zig && zig build test`

## Case folding, `word` and `word break`

- Implementation: [folding](src/unicode/case.zig), [words](src/unicode/words.zig)
- Rules: [Text](../../spec/03-values.md#text), [chunk kinds](../../spec/04-expressions-and-statements.md#chunk-kinds)
- Tests and cases: [conformance tests](src/unicode/conformance_test.zig), tests in each file
- First check: `cd impl/zig && zig build test`

## The `std` Unicode policy

- Implementation: [policy test](src/unicode/policy_test.zig)
- Rules: [decisions on #625](https://github.com/odogono/odgn-talk/issues/625#issuecomment-6111271797)
- Tests and cases: the same
- First check: `cd impl/zig && zig build test`

## Decimal input, conversion and arithmetic

- Implementation: [decimal](src/decimal/decimal.zig)
- Rules: [numbers](../../spec/03-values.md#numbers), [Host values](../../spec/09-embedding.md#values-at-the-boundary)
- Tests and cases: tests in the module, [C Host tests](tests/talk_h_test.c)
- First check: `cd impl/zig && zig build test`

## Values, equality and copy-on-write

- Implementation: [values](src/value.zig), [Units](src/units.zig), [dates](src/dates.zig)
- Rules: [values](../../spec/03-values.md)
- Tests and cases: tests in the modules
- First check: `cd impl/zig && zig build test`

## Display and Value Encoding

- Implementation: [display](src/display.zig), [encoding](src/encoding.zig), [Pattern source](src/pattern.zig)
- Rules: [display](../../spec/11-the-trace-and-conformance.md#the-display-form), [Value Encoding](../../spec/09-embedding.md#json-and-the-value-encoding)
- Tests and cases: module tests
- First check: `cd impl/zig && zig build corpus -- bytes/value-encoding`

## Lexing: tokens, modes, Units and fenced text

- Implementation: [lexer](src/syntax/lexer.zig)
- Rules: [chapter 1](../../spec/01-lexical-structure.md), [syntax errors](../../spec/02-grammar.md#syntax-errors)
- Tests and cases: tests in the module
- First check: `cd impl/zig && zig build test`

## Parsing and the syntax tree

- Implementation: [parser](src/syntax/parser.zig), [tree](src/syntax/ast.zig)
- Rules: [chapter 2](../../spec/02-grammar.md), [`grammar.ebnf`](../../spec/data/grammar.ebnf), [`grammar.toml`](../../spec/data/grammar.toml)
- Tests and cases: module tests, [broken sources](../../tools/grammar/broken.talk), every corpus `.talk` file
- First check: `cd impl/zig && zig build test`

## Load-time diagnostics and name resolution

- Implementation: [checker](src/check/check.zig)
- Rules: [load-time diagnostics](../../spec/02-grammar.md#load-time-diagnostics), [resolving a name](../../spec/04-expressions-and-statements.md#resolving-a-name), [Suspension Points](../../spec/05-handlers-messages-and-scheduling.md#suspension-points), [`diagnostics.toml`](../../spec/data/diagnostics.toml)
- Tests and cases: module tests, every corpus unit's expected `diag` lines
- First check: `cd impl/zig && zig build test`

## Lowering, code units and the canonical disassembly

- Implementation: [lowering](src/lower/lower.zig)
- Rules: [the lowering](../../spec/08-the-abstract-machine-and-the-cost-model.md#the-lowering), [the source map](../../spec/08-the-abstract-machine-and-the-cost-model.md#the-source-map), [`machine.toml`](../../spec/data/machine.toml)
- Tests and cases: module tests, [Disassembly Cases](src/corpus/disassembly.zig)
- First check: `cd impl/zig && zig build corpus -- disassembly`

## Case setup: units, Grants and objects

- Implementation: [case setup](src/corpus/case.zig)
- Rules: [`case.toml`](../../spec/11-the-trace-and-conformance.md#casetoml)
- Tests and cases: tests in the module, every corpus `case.toml`
- First check: `cd impl/zig && zig build test`

## Running code: Groups, Pumps, the run loop, errors and unwinding, Capability calls, suspension, sends, Joins and `wait for`, the Fallback Handler, Queueing Policies and cancellation, Host Objects and the Message Path, Libraries and the stdlib, Lambdas and Function Values, Built-ins and date arithmetic, and charging

- Implementation: [machine](src/machine/machine.zig), [chunks and properties](src/machine/chunks.zig), [Bytes builds and Binary Patterns](src/machine/binary.zig), [conversions](src/machine/convert.zig), [Text Patterns and the matcher](src/machine/matcher.zig), [Capabilities, Shapes and Grants](src/machine/capabilities.zig), [Standard Capabilities](src/machine/standard.zig), [Host Objects](src/machine/objects.zig), [Group allocator](src/machine/group_allocator.zig), [process allocator and wasm heap](src/process_allocator.zig), [stdlib sources](src/generated/stdlib_sources.zig), [Cost Model](src/machine/costs.zig), [Built-ins](src/machine/builtins.zig), [correctly rounded functions](src/decimal/transcendental.zig), [exports](src/talk.zig)
- Rules: [the machine](../../spec/08-the-abstract-machine-and-the-cost-model.md#the-machines-state), [the Cost Model](../../spec/08-the-abstract-machine-and-the-cost-model.md#the-cost-model), [chunks](../../spec/04-expressions-and-statements.md#chunk-expressions), [the Trace](../../spec/11-the-trace-and-conformance.md#the-trace), [Libraries](../../spec/07-libraries-and-the-standard-library.md#libraries)
- Tests and cases: [replay](src/corpus/replay.zig), [talk.h replay](src/corpus/talk_replay.zig), [C Host tests](tests/talk_h_test.c), [fast path against the general loop](src/machine/fast_steps_test.zig)
- First check: `cd impl/zig && zig build corpus -- text-model`

## Waits, suspending Calls and their abandonment

- Implementation: [the Wait table](src/machine/waits.zig) (pending Waits, their order and deadlines, Run and Join Member references, suspending Call registration, abandonment, settlement, retirement and save export/import), [machine](src/machine/machine.zig) (scheduling, Charge requests and Trace writes), [Calls](src/machine/capabilities.zig), [issued Call ranges](src/machine/issued_calls.zig), [saves](src/machine/snapshot.zig). `snapshot.zig` encodes the Wait table’s export and restores through its import methods; the ownership boundary follows [ADR 0105](../../docs/adr/0105-each-core-keeps-its-waits-in-one-wait-table-module.md).
- Rules: [Suspension Points](../../spec/05-handlers-messages-and-scheduling.md#suspension-points), [the Trace](../../spec/11-the-trace-and-conformance.md#the-trace)
- Tests and cases: tests in the Wait table, [metering tests](src/machine/metering_test.zig), [crossing tests](src/machine/crossing_test.zig), [lifecycle tests](src/machine/lifecycle_test.zig), [C Host tests](tests/talk_h_test.c)
- First check: `cd impl/zig && zig build test`

## Run lifecycle, Stretches and endings

- Implementation: [the Run lifecycle](src/machine/run_lifecycle.zig) (a Run's state between turns, its place in its Script's live Runs and work, detaching it, the start and end of each Stretch, the Fuel paid into the Pump's and Script's totals, the one fault for a refused Charge, and whether a Run can be rewound), [machine](src/machine/machine.zig) (which Run goes next, `endSegment` and `endRun`, and every `preempt`, `seg`, `fault` and `abandon` record). The boundary follows [ADR 0123](../../docs/adr/0123-the-zig-core-keeps-a-runs-lifecycle-in-one-module.md).
- Rules: [Suspension Points](../../spec/05-handlers-messages-and-scheduling.md#suspension-points), [the Trace](../../spec/11-the-trace-and-conformance.md#the-trace)
- Tests and cases: tests in the Run lifecycle, [lifecycle tests](src/machine/lifecycle_test.zig), [metering tests](src/machine/metering_test.zig), [crossing tests](src/machine/crossing_test.zig), `zig build corpus -- --defer-crossings`
- First check: `cd impl/zig && zig build test`

## Metered Operations and request admission

- Implementation: [machine](src/machine/machine.zig), [declarations and Calls](src/machine/capabilities.zig), [SQLite factory](src/talk.zig), [Message Layer](src/message.zig)
- Rules: [metering contract](../../spec/embedding/metered-operations.md), [staged handoff](../../docs/handoffs/472-metered-operations.md)
- Tests and cases: [Zig-only acceptance](src/machine/metering_test.zig), [C Host tests](tests/talk_h_test.c), Message Layer and replay tests
- First check: `cd impl/zig && zig build test`

## Pump reports and Run accounting

- Implementation: [reports](src/machine/reports.zig), [machine](src/machine/machine.zig), [exports](src/talk.zig), [`talk.h`](include/talk.h)
- Rules: [reports](../../spec/09-embedding.md#run-accounting), [`talk.go`](../../spec/embedding/talk.go)
- Tests and cases: tests in the module, [C Host tests](tests/talk_h_test.c), [talk.h replay](src/corpus/talk_replay.zig), [shared accounting fixtures](../testdata/run-accounting.json)
- First check: `cd impl/zig && zig build test`

## Inspect

- Implementation: [exports](src/talk.zig), [`talk.h`](include/talk.h)
- Rules: [Inspect](../../spec/09-embedding.md#the-pump-and-the-group-fingerprint), [`:runs`, `:mailbox` and `:vars`](../../spec/12-sessions-and-tooling.md#session-commands)
- Tests and cases: tests in the module, [C Host tests](tests/talk_h_test.c)
- First check: `cd impl/zig && zig build test`

## The Session Host, the REPL and Session Transcripts

- Implementation: [Session Host](src/session/session.zig), [language analysis](src/analysis.zig) (also the Message Layer's `analysis-v1`), [Transcripts](src/session/transcript.zig), [REPL](src/repl/main.zig), [Transcript cases](src/corpus/session_case.zig)
- Rules: [chapter 12](../../spec/12-sessions-and-tooling.md), [Session observation](../../spec/session-observation.md), [`session.toml`](../../spec/data/session.toml)
- Tests and cases: `corpus/sessions/`
- First check: `cd impl/zig && zig build corpus -- sessions`

## The Script Runner and the HTTP router

- Implementation: [Runner](src/runner/runner.zig), [HTTP router](src/runner/router.zig), [requests](src/runner/request.zig), [`northtalk`](src/repl/main.zig)
- Rules: [The Script Runner](../../spec/12-sessions-and-tooling.md#the-script-runner), [The HTTP router](../../spec/09-embedding.md#the-http-router), [`http`](../../spec/07-libraries-and-the-standard-library.md#http)
- Tests and cases: tests in the modules, [`smoke.zig`](src/runner/smoke.zig) on `examples/http/hello.talk`, [`http_kit.zig`](src/runner/http_kit.zig) on `corpus/http-kit/`
- First check: `cd impl/zig && zig build runner-test http-kit`

## Store Notification routing and checkpoints

- Implementation: [router](src/notify/router.zig), [`talk.h`](include/talk.h)
- Rules: [routing](../../spec/07-libraries-and-the-standard-library.md#store-notification-routing), [watch limits](../../spec/07-libraries-and-the-standard-library.md#store-watch-limits), [checkpoints](../../spec/10-save-and-restore.md#store-notification-checkpoints)
- Tests and cases: tests in the module, [C Host tests](tests/talk_h_test.c)
- First check: `cd impl/zig && zig build test`

## Reload, extend Script and Library replacement

- Implementation: [machine](src/machine/machine.zig), [checker's inherited names](src/check/check.zig), [lowering](src/lower/lower.zig), [exports](src/talk.zig)
- Rules: [Reload and extend](../../spec/10-save-and-restore.md#reload-and-extend), [code units](../../spec/08-the-abstract-machine-and-the-cost-model.md#code-units), [replacing a Library](../../spec/07-libraries-and-the-standard-library.md#registering-identity-and-replacing)
- Tests and cases: [talk.h replay](src/corpus/talk_replay.zig), [C Host tests](tests/talk_h_test.c)
- First check: `cd impl/zig && zig build corpus -- reload`

## Save, restore, settling and the Group Fingerprint

- Implementation: [snapshot](src/machine/snapshot.zig), [Fingerprint](src/machine/fingerprint.zig), [machine](src/machine/machine.zig), [exports](src/talk.zig)
- Rules: [save and restore](../../spec/10-save-and-restore.md), [the Group Fingerprint](../../spec/09-embedding.md#the-pump-and-the-group-fingerprint)
- Tests and cases: tests in the modules, [talk.h replay](src/corpus/talk_replay.zig), [C Host tests](tests/talk_h_test.c)
- First check: `cd impl/zig && zig build corpus -- save-restore`

## The Host Manifest

- Implementation: [manifest](src/machine/manifest.zig), [Fingerprint's declaration writer](src/machine/fingerprint.zig), [exports](src/talk.zig)
- Rules: [the Host Manifest format](../../spec/09-embedding.md#the-host-manifest-format), [the data model](../../spec/09-embedding.md#the-pump-and-the-group-fingerprint)
- Tests and cases: [C Host tests](tests/talk_h_test.c)
- First check: `cd impl/zig && zig build test`

## Corpus discovery, Trace parsing and backend seam

- Implementation: [runner](src/corpus/main.zig), [Trace parser](src/corpus/trace.zig)
- Rules: [conformance](../../spec/11-the-trace-and-conformance.md), [record catalogue](../../spec/data/corpus.toml), [grammar](../../spec/data/trace.ebnf)
- Tests and cases: module tests
- First check: `cd impl/zig && zig build corpus -- --list`; CI also runs `zig build corpus -- --defer-crossings`

## The differential fuzz worker

- Implementation: [worker](src/corpus/fuzzworker.zig), [replay Host](src/corpus/talk_replay.zig)
- Rules: [the fuzzer](../../tooling/fuzz/README.md#dual-core-mode)
- Tests and cases: [TS and Zig witnesses](../../tooling/fuzz/tests/zig-runner.test.ts)
- First check: `cd tooling/fuzz && bun test tests/zig-runner.test.ts`

## Generated tables

- Implementation: [catalogue emitter](../../tools/zig/generate.ts), [Unicode emitter](../../tools/unicode/generate-zig.ts) → [tables](src/generated/)
- Rules: [Data Files](../../spec/README.md#data-files)
- Tests and cases: [emitter tests](../../tools/zig/generate.test.ts)
- First check: `bun run zig:check && bun run unicode:check`

## The C API

- Implementation: [`talk.h`](include/talk.h), [exports](src/talk.zig)
- Rules: [embedding](../../spec/09-embedding.md), [`talk.go`](../../spec/embedding/talk.go)
- Tests and cases: [API check](../../tools/zig/api.ts) and [its tests](../../tools/zig/api.test.ts), [C Host tests](tests/talk_h_test.c); link a C Host with `zig cc`, not the system `cc` ([why](README.md#building-and-testing))
- First check: `bun tools/zig/api.ts`

## The Message Layer on `wasm32-wasi`: `talk_buffer`/`talk_send`, frames, needs and Reports

- Implementation: [message layer](src/message.zig) (`handle` → `handleFrame` → `dispatch` → `queuedReply`/`pumpReply`), [exchanges](src/exchange.zig) (a Pump's or Reload's state between frames: gating results and paused inputs, pauses, held replies, Grant releases and each Group's parked exchange), [machine](src/machine/machine.zig) (crossing pause, RunEnd reports; `pub const Group`, `fn pump`, `fn startCancel`, `fn cancelDelivery`, `fn preempt`)
- Rules: [the message layer](../../spec/09-embedding.md#the-message-layer), [decisions on #625](https://github.com/odogono/odgn-talk/issues/625#issuecomment-6111271797)
- Tests and cases: tests in the module, [WASI checks](../../tools/wasi/zig.py), [the reactor check](../../tools/wasi/check.py), [List memory and fault reuse](../../tools/wasi/list_memory.py)
- First check: `uv run tools/wasi/check.py impl/zig/zig-out/bin/talk.wasm`

## Binary Request/Pump and combined calls

- Implementation: [envelope](src/request_pump.zig), [binary Values](src/binary_value.zig), [binary frames](src/message.zig) (`fn handleBinary`), [exports](src/talk.zig)
- Rules: [the binary exchange](../../spec/embedding/request-pump-binary.md), [ADR 0110](../../docs/adr/0110-request-and-pump-have-an-optional-binary-exchange.md), [measurements](../../docs/research/request-pump-binary.md)
- Tests and cases: tests in the modules; the Go adapter's [combined tests](../go/zig_combined_test.go) run the binary exchange with `TALK_ZIG_REQUEST_PUMP=fields`, as the [Go workflow](../../.github/workflows/go.yml) does
- First check: `cd impl/zig && zig build test`; envelope gates: `impl/go/request-pump-bench.sh`

## After changing the Zig Core

The Go adapter and the Elixir package each run a pinned copy of the WASI reactor, so a Zig change reaches them only through these steps:

1. Try uncommitted Zig in Go with `impl/go/hand-swap.sh` (the [hand swap](../go/README.md#hand-swap)), then gate it with `CGO_ENABLED=0 impl/go/adapter-check.sh`. Restore with `git checkout -- impl/go/internal/zigwasm`.
2. Commit the Zig change, then run `python3 impl/go/build-artifact.py`. It refreshes the embedded copy in `impl/go/internal/zigwasm` with its digest; commit its output. It refuses uncommitted Core or spec changes. After a rebase, rerun it rather than merging those files by hand.
3. If `format_version` in [`snapshot.zig`](src/machine/snapshot.zig) changed, set `@save_format` in [`artifact.ex`](../elixir/lib/north_talk/artifact.ex) and the assertion in [`fault_test.exs`](../elixir/test/fault_test.exs), then follow [the pinned reactor release](../elixir/NAVIGATION.md#the-pinned-reactor-release). `bun run check` fails until the two agree.

## Build, targets and CI

- Implementation: [`build.zig`](build.zig), [`build.zig.zon`](build.zig.zon), [workflow](../../.github/workflows/zig.yml)
- Rules: [ADR 0078](../../docs/adr/0078-the-zig-third-core-is-built-though-the-message-layer-meets-its-thresholds.md)
- Tests and cases: the workflow's steps
- First check: `cd impl/zig && zig build -Dtarget=wasm32-wasi`; then from the root `uv run tools/wasi/zig.py impl/zig/zig-out/bin/talk.wasm`

## Native Message Layer sidecar

- Implementation: [stdio transport](src/sidecar.zig), [shared Session and dispatcher](src/message.zig)
- Rules: [Message Layer](../../spec/09-embedding.md#the-message-layer), [ADR 0090](../../docs/adr/0090-the-native-message-layer-sidecar-uses-zig.md)
- Tests and cases: [executable checks](../../tools/sidecar/check.py), module tests, [Elixir Port Host](../../bench/message-layer/elixir/), [process memory](../../tools/wasi/list_memory.py)
- First check: `cd impl/zig && zig build sidecar`; then `python3 tools/sidecar/check.py impl/zig/zig-out/bin/messagelayer` from the root

Instruction scratch reset's arena-state fast path lives in
[`scratch.zig`](src/machine/scratch.zig); its tests cover empty and dirty
buffers, chains, free lists and refused allocation/consolidation.

Update generated files through their generators. A Zig upgrade is its own PR
and changes no behaviour.

For Session Host work, first check [C API coverage](../../tools/zig/api.ts) with
`bun tools/zig/api.ts`: inspect missing Reports, Run accounting, Inspection and
Notification routing before planning Transcript support. The guide owns
[current support](README.md); the [corpus guide](../../corpus/README.md#replay-modes-and-backends)
distinguishes Transcript replay from the two Trace replay modes.
