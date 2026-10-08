# Session observation: implementation handoff and acceptance

Design agreed for [#370](https://github.com/odogono/odgn-talk/issues/370). This is one coordinated release across both Cores, Session Hosts, CLI, Playground, LSP and formatter. This handoff records delivery evidence; normative behavior is in [Session observation](../../spec/session-observation.md), [Run accounting](../../spec/09-embedding.md#run-accounting), the embedding declarations and the Data Files.

## Required base and delivery state

- **Required base:** specification commit `f56430488cb9425e3f1c0b7a4a63c85f451d45bc` on `docs/grill-issue-370`, based on `927f0e8121114db24a89aaa70e503bc8980b738b`. Use [PR #430](https://github.com/odogono/odgn-talk/pull/430), including its subsequent declaration-staging correction, as the implementation base; the initial specification commit alone predates that correction. The specification is committed; no uncommitted source files need to be carried to another checkout.
- **Specification files:** `CONTEXT.md`; `docs/adr/0065-run-accounting-is-returned-to-every-host.md`, `0066-fuel-measurements-follow-spawned-runs.md`, `0067-inspection-is-replayable-ordinary-execution.md`, `0045-the-session-host-follows-its-runs-through-the-trace.md` and `README.md` in that directory; `spec/session-observation.md`, `spec/session/inspect-reader.talk`; `spec/09-embedding.md`, `spec/10-save-and-restore.md`, `spec/11-the-trace-and-conformance.md`, `spec/12-sessions-and-tooling.md`, `spec/README.md`, `spec/appendix-a-glossary.md`; `spec/embedding/talk.go`, `spec/embedding/talk.ts`; `spec/data/session.toml`, `spec/data/trace.ebnf`.
- **Companion files:** this handoff; current limitations in `impl/ts/README.md`, `impl/go/README.md`, `tooling/stack/README.md`, `tooling/cli/README.md`, `tooling/playground/README.md`; `changelog/unreleased/session-observation-spec.md`.
- **Implemented in:** specification and data/declaration updates only. No runtime or tooling behavior is implemented by this change. Current support is described beside each affected feature in the guides above.
- **Deferred Data Files and declarations:** command/Transcript Data Files are updated. The exact `RestoreResult` amendment is staged in chapter 9: add `Reports []Report` in `spec/embedding/talk.go`, `reports: Report[]` in `spec/embedding/talk.ts`, and the worker reply field when both Core implementations can return the specified baseline. No new grammar production, Built-in, machine instruction, cost, error catalogue entry or canonical Trace record is required. `corpus.toml` is unchanged: object setup lives in the standalone Transcript, not a second corpus-only setup.
- **Remaining work:** all unchecked acceptance below, including both implementations of the normative inspection-Handler template and its first expectations. Keep this block synchronized with implementation PRs/commits and issue #370; do not close the issue when only the specification lands.
- **Approval still needed:** no new expectations exist in this change. Implementation must enumerate every new or changed `session.transcript`/`case.trace` and public-report fixture with review links before first blessing. Agreement between Cores is not reviewer approval.

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
- [ ] Formatting is idempotent, preserves doc attachment and disassembly; hover shares the same extraction and identity resolution.

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

The Go API comparison must pass for the existing interface. The pending `RestoreResult.Reports` field is documented as a staged amendment and must be activated with its implementation. Missing new report declarations may only be logged by that checker, so its result must be read alongside this checklist rather than treated as complete coverage.

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
