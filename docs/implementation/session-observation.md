# Session observation: implementation handoff and acceptance

Design agreed for [#370](https://github.com/odogono/odgn-talk/issues/370). This is one coordinated release across both Cores, Session Hosts, CLI, Playground, LSP and formatter. This handoff records delivery evidence; normative behavior is in [Session observation](../../spec/session-observation.md), [Run accounting](../../spec/09-embedding.md#run-accounting), the embedding declarations and the Data Files.

## Required base and delivery state

- **Required base:** merged specification PR #430, commit `8957d3e7e3a8018176eea6185269f0276a54683e`, or a descendant. No uncommitted specification files need to be carried.
- **Specification files:** `CONTEXT.md`; `docs/adr/0065-run-accounting-is-returned-to-every-host.md`, `0066-fuel-measurements-follow-spawned-runs.md`, `0067-inspection-is-replayable-ordinary-execution.md`, `0045-the-session-host-follows-its-runs-through-the-trace.md` and `README.md` in that directory; `spec/session-observation.md`, `spec/session/inspect-reader.talk`; `spec/09-embedding.md`, `spec/10-save-and-restore.md`, `spec/11-the-trace-and-conformance.md`, `spec/12-sessions-and-tooling.md`, `spec/README.md`, `spec/appendix-a-glossary.md`; `spec/embedding/talk.go`, `spec/embedding/talk.ts`; `spec/data/session.toml`, `spec/data/trace.ebnf`.
- **Companion files:** this handoff; current limitations in `impl/ts/README.md`, `impl/go/README.md`, `tooling/stack/README.md`, `tooling/cli/README.md`, `tooling/playground/README.md`; `changelog/unreleased/session-observation-spec.md`.
- **Implemented in:** #430 supplies the normative contract. #435 adds public Run accounting and saved ancestry in both Cores, including the real `RestoreResult.reports` baseline. #436 adds Declaration Documentation to both Cores and Session Hosts: attachment, prompt collection, retention by declaration and code identity, Built-in descriptions and stale documentation in saves. #441 (PR #446) documents each stdlib Library export with its `stdlib.toml` `gives`. Tooling documentation (#440) adds hover using Core extraction and binding identity, doc-preserving Playground Apply and multiline prompt paste. #438 adds `:trace`, `:untrace` and `:fuel` to both Session Hosts, the Go REPL, the CLI and the Playground. The remaining Session Commands and object-crossing replay stay pending, tracked as sub-issues of #370 (#437, #439).
- **Data Files and declarations:** command/Transcript Data Files are updated. `RestoreResult.Reports`/`reports` is now active in the Go/TS declarations with runtime support. The specified worker reply includes `reports`. No new grammar production, Built-in, machine instruction, cost, error catalogue entry or canonical Trace record is required. `corpus.toml` is unchanged.
- **Remaining work:** all unchecked acceptance below, including both implementations of the normative inspection-Handler template and its first expectations. Keep this block synchronized with implementation PRs/commits and issue #370; do not close the issue when only the specification lands.
- **Approved:** the maintainer approved the first blessing of [the public-report fixture](../../impl/testdata/run-accounting.json) and [the Declaration Documentation fixture](../../impl/testdata/declaration-docs.json) on 2026-10-08, at `d289156` (after #446).
- **Approval still needed:** [the proposed `sessions/observation` Transcript](../../corpus/sessions/observation/session.transcript) and [its Trace](../../corpus/sessions/observation/case.trace) (#438) require first-blessing review; both Cores agree on them, which is verification, not approval. No existing `session.transcript` or `case.trace` expectations changed. Future command fixtures must also be listed with review links before first blessing.

## Implementation boundaries

1. Both Cores expose ordered `RunStarted`/`RunDiscarded`, existing `RunEnd`, cumulative `RunAccounting` and `CausalWork` reports. Cover non-Pump lifecycle returns and `RestoreResult.reports`; preserve saved ancestry and return final observations before deleting work.
2. Session Hosts retain source documentation by code identity, use canonical name targets, and render the specified rows. Implement both command completeness and `--|` prompt collection. Keep passive variable snapshots explicit in the Trace.
3. Compile inspection helpers through ordinary lowering. Use `spec/session/inspect-reader.talk` with the specified hygienic renaming in both implementations and pin its `extend` Trace source, Fuel and output with the first inspection cases. The helper's caught errors must use the existing Session parity projection, not platform-specific messages.
4. Transcript codecs and both replay backends support `%` envelopes, dynamic object identities, ordered property actions, resolver outcomes, escaped output and standalone setup. Preserve existing transcript behavior without envelopes. Compare accounting through a separate direct API test harness because Trace files do not contain it.
5. LSP, CLI and Playground reuse documentation/Entry rules and Session commands. Keep Playground selection UI (#336) and LSP senders/implementors navigation (#334) out of this release; their future consumers can reuse the same inspection and declaration data.

## Coordinated release acceptance

### Documentation, discovery and passive values

- [ ] Consecutive marked lines, empty marked lines, indentation, ordinary comments and blank-line separation attach identically in both Session Hosts and tooling.
- [ ] Prompt collection handles incomplete declarations, invalid non-declarations and cancellation; Enter/Apply/paste behavior agrees across CLI and Playground.
- [ ] Redefinition with/without docs, repeated Script Variables, imports/aliases, Library replacement and export round trips show current docs; old Function Values retain original docs.
- [ ] Handler clauses remain independently documented and ordered. Anonymous Lambdas, undocumented declarations and Built-ins render the defined empty/catalogue docs.
- [ ] Apropos handles unimported exports, shadowed Built-ins, aliases, Unicode lowercase expansion/NFC, empty query, no matches and reusable qualified targets without importing or executing anything.
- [ ] Describe of a Script Variable produces exactly one explicit snapshot; other passive metadata lookups do not. No getter is called by describe.
- [x] Formatting is idempotent, preserves doc attachment and disassembly; hover shares the same extraction and identity resolution.

### Accounting, tracing and Fuel

- [ ] Cross-Core public reports agree for same-call start/end, multiple roots, parked/suspended Runs, observed messages, rejected/dropped deliveries and same-call discard.
- [ ] Observation-test Fuel, cleanup, failed conversion, limits, restored-call Reissue and cancellation are exact; Segment summation is not used as an approximation.
- [ ] Detached sends, Join, foreign Function Values, error Handlers and Message Path forwarding retain ancestry. Independent Host callbacks/timers and pre-existing waiting Runs are excluded from the sender's family.
- [ ] A finished parent with queued or waiting descendants stays pending; queued work dropped without a Run closes with correct interruption state. Never infer settlement from quiescence alone.
- [ ] Stop, Reload, Library replacement and every Restore policy preserve exact final Fuel and queued discard counts. Surviving descendants remain tracked.
- [ ] Trace filters match full Selectors across Scripts, never local calls, and retain terminal pairs after untrace. Start/end order and ordinary-output/Fuel ordering agree at each Host boundary.
- [ ] Fuel rejects declarations atomically, prints one initial/final row as specified, reports exact active totals on demand and does not spam background updates.
- [ ] Saves/restore rewind IDs, filters, latched pairs, measurements and documentation; abandoned future totals cannot double count into restored work.

### Inspection and object replay

- [ ] The expression executes once. Scalar/map/function inspection does not allocate a reader Run; object inspection uses exactly the separate ordinary reader Run.
- [ ] Both Runs use normal limits, lowering and costs. Interleaving or disposal between them is observable; cancelling the first never starts the second.
- [ ] Property declarations come from the actual Object Kind. Reads are one level and code-point ordered; nested objects/functions are not invoked recursively.
- [ ] Getter errors print a parity-safe per-property row and continue. A later Limit Fault/cancellation/fatal effect failure leaves prior printed rows visible.
- [ ] Initial bindings, dynamically returned objects, parent changes, disposal, queued deliveries and refused Host actions replay without native objects or external I/O.
- [ ] Property callbacks reproduce result/error Shape checks and conversion costs, including actions queued before a getter fails; failures before a callback do not consume fabricated crossing records.
- [ ] Preserve insertion order inside encoded values; test nested Function Value references and dollar-prefixed ordinary map keys. Reject unresolved references, malformed/extra fields, duplicate keys and unmatched/out-of-order crossings.
- [ ] Standalone Transcript replay and corpus Trace replay agree with live recording, including Restore resolver outcomes and `%`-prefixed ordinary console output.

## Verification commands and evidence

For this specification change, run `bun run spec:gen`, `bun run check`, `bun run go:check`, the Go API comparison, and existing focused Session/Transcript and both-Core Session corpus checks. Record actual results below. Do not weaken a test to hide declared-but-unimplemented behavior.

For runtime acceptance, additionally run affected Group/save/restore/property tests, direct public-accounting parity tests, CLI/Playground/LSP/formatter tests and all new corpus cases in both replay modes. Passing the old corpus does not prove these new features exist.

The Go API comparison must pass for the active interface, including `RestoreResult.Reports` and the accounting report types. API declaration agreement alone does not establish runtime behavior; use the direct report tests.

### Evidence from the specification worktree (2026-10-08)

- `bun run check`: passed, including 20 tools tests, generated-region/schema checks, grammar/lowering checks, 318 existing corpus formats and pinned Unicode tables.
- `bun run go:check`: passed.
- `bun test impl/ts/tests/session.test.ts impl/ts/tests/transcript.test.ts`: 54 tests passed.
- `go -C impl/go test ./session`: passed.
- `bun run corpus:run sessions`: all 11 existing Session cases passed.
- Go `cmd/corpus`, given the 11 individual `sessions/<case>` names: all passed. The Go runner takes individual cases, not a directory prefix.
- Initial `go -C impl/go test ./internal/apicheck -run TestEmbeddingAPI -v` failed because this spec-only change prematurely added `RestoreResult.Reports` to the active declaration. The correction stages that existing-type amendment in chapter 9 and restores the active Go/TS shape; the same unchanged API comparison now passes. It still logs five new accounting types and four pre-existing missing declarations, which are not runtime support. No check was weakened and no runtime stubs were added.
- The normative inspection reader template loads and executes on both existing Cores: a map property produces the same success row, and a wrong-kind read produces the same projected error row. This is a source-template smoke check, not implementation of `:inspect` or object replay.
- No new behavior expectations were generated or blessed. These results verify the documentation change and existing behavior, not implementation of the new contract.

### Accounting implementation evidence (2026-10-08)

- Direct Go/TS tests and the shared proposed public-report fixture cover same-call dispatch/end, call ancestry, detached error Handlers, cumulative Fuel and unchanged boundaries. Additional tests cover observation-only Fuel, queued descendants, full/variables-only/rejected restore, cancellation, same-Pump discard, Library replacement and restored-call Reissue.
- Both complete Core suites pass; Go also passes `go vet ./...` and `go test -race ./...`. TS: 3,453 tests. Tooling: 1,763 tests.
- The complete Go corpus, TS corpus tests, browser bundle smoke test, workspace typecheck, lint, formatting, `bun run check`, `spec:check` and `go:check` pass. Canonical Trace expectations are unchanged.
- Private save formats advance to Go `go/3` and TS `3` because saved ancestry and accounting order are required. Older snapshots are rejected; no automatic migration is provided.
- Release acceptance above remains open pending the remaining command/tooling cases. The fixture's first blessing was approved separately on 2026-10-08 (see Required base and delivery state).

### Declaration Documentation evidence (2026-10-08)

- Both Cores read the shared proposed fixture `impl/testdata/declaration-docs.json`. Go runs it in `session/documentation_test.go` and TS in `tests/documentation.test.ts`. It covers attachment rules (indentation, empty marked lines, one stripped space, ordinary comments, blank lines, trailing comments, CRLF/CR, BOM, `private`, Imports and the Fallback Handler), prompt completeness and refusal, and redefinition with and without docs. It also covers repeated Script Variables, including an `=` inside a doc block, Handler Clauses, Library exports, private declarations, Import aliases and Built-ins. Its remaining cases cover `:export`, stale Function Values across `:save`/`:restore`, and Library replacement.
- Direct Core tests in both Cores cover stale Function Value documentation across Reload, full restore and variables-only restore. Both variables-only tests fail when their fix is removed.
- The formatter test shows formatting is idempotent and keeps each declaration's documentation.
- Saves move to Go `go/4` and TS `4` so a stale Function Value's documentation survives restore. A variables-only restore keeps the saved code's documentation. No canonical Trace or Transcript expectations changed.
- Fixed in Go: redeclaring a Script Variable found its initializer with the first `=` in the source, which could fall inside a leading doc block.
- At the Declaration Documentation implementation step, hover, Playground Apply and describe/apropos output remained open. The tooling evidence below covers #440; describe/apropos output remains tracked by #437. First-blessing approval for the shared fixture remains separate from this tooling verification.

### Tooling documentation evidence (2026-10-08, #440)

- LSP hover reads the Core's `SemanticTree.docs`, resolves Import aliases to their defining Library binding and uses the same Built-in catalogue descriptions as `SessionHost.documentation`. Handler Clauses are shown separately in source order. Parameters and locals do not inherit top-level documentation by spelling, and Library changes refresh imported documentation.
- Playground Apply uses the Core's doc-block boundary to retain exact attached comments while identifying declarations from their syntax. Documentation-only edits redefine the declaration; undocumented replacements remove old documentation. Blocks before Imports are refused as at the prompt.
- CLI integration and Playground Session/worker tests cover leading doc-block collection, empty marked lines, detached blocks, invalid attachments, cancellation, redefinition and Transcript round trips. The browser prompt preserves multiline pasted input, submits complete physical lines through the same Entry collector and leaves the last line for Enter.
- Formatter tests verify idempotence, attachment and unchanged executable disassembly across LF, CRLF and CR source. Existing shared Declaration Documentation expectations and canonical Trace/Transcript fixtures are unchanged; their first-blessing approval was pending at this step and was approved later (see Required base and delivery state).
- Verification: `bun test tooling impl/ts/tests/documentation.test.ts impl/ts/tests/session.test.ts` passes 1,858 tests; workspace typecheck, lint, formatting and build pass. Tooling and CLI Node runtime checks pass. Browser verification confirms that multiline prompt paste preserves the block through the final Enter and that Script-tab Apply records attached documentation, hover displays it and the applied function executes correctly.

### Tracing and Fuel evidence (2026-10-08)

- Both Session Hosts implement `:trace`, `:untrace` and `:fuel` from the public reports alone, in `impl/go/session/observe.go` and `impl/ts/src/session/observe.ts`. They make no `Inspect()` call and add no Host Input beyond the measured Entry's ordinary `extend`, `request` and `pump`.
- The proposed `sessions/observation` case was blessed with `bun run corpus:bless`: TS and Go agree on its Transcript and Trace, in both replays. It covers filter listing, sorting and refusal, local Command Calls that are not traced, labelled Selectors, error Handler and detached-send ancestry, a waiting member keeping a measurement pending, a terminal row after `:untrace`, a cancelled Run that is not interrupted, a depth Limit Fault, refused declarations, commands and syntax, `:save`/`:restore` with `fuel abandoned`, and a Reload that discards a member and interrupts its measurement. It is in the Go passing gate.
- Unit tests in both Cores cover multiline `:fuel` continuation and a measurement that yields to `read`: a pending row at the yield, then one final row at settlement.
- Arguments and results in trace rows use the Trace's display, so a Core-generated error `message` stays out of them. Go reaches it through an internal hook, as Declaration Documentation does.
- Not covered by a Session case: queued descendant messages and Library replacement. The Core accounting tests (#435) cover their reports; the Session Host only sums them.

### Standard Library documentation evidence (#441, PR #446, 2026-10-08)

- Each of the 63 stdlib Library exports carries one `--|` line equal to its `stdlib.toml` `gives`; `spec:check` fails when they differ.
- The shared fixture's `text.join` row now expects that text. Five corpus cases were reblessed with TS and Go agreeing; only Code identities and `pos` lines inside Library sources changed, so Fuel, error codes and order are unchanged.
