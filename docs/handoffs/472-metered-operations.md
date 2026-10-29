# Metered Operations: specification handoff for #472

## Required base and delivery boundary

- **Specification revision / required base:** [PR #723](https://github.com/odogono/odgn-talk/pull/723), branch `docs/grill-issue-472`, based on `18877eaafa58df7990e4f13e6c2cd0cac80adec1`. Use the latest PR head or its merged successor. The initial specification commit `baac99a8c30ab2bf1e4322784dde0e5243649d7c` alone is insufficient: subsequent changes stage the target API declarations so checked interfaces continue to match runtime support.
- **Implemented in:** the Zig runtime change for [#911](https://github.com/odogono/odgn-talk/issues/911) is prepared on `fix/issue-911`, with acceptance in its native, C Host, Message Layer, replay and WASI tests; its merge reference is pending. The normative contract is [Metered Operations](../../spec/embedding/metered-operations.md), with [ADR 0082](../adr/0082-metered-operations-authorize-work-through-the-pump.md) and [staged Go/TS target declarations](../../spec/embedding/metered-operations.md#target-embedding-declarations).
- **Remaining work:** the TS Core implements declarations, charge requests and their saves ([#1748](https://github.com/odogono/odgn-talk/issues/1748)); still remaining are the Go runtime, TS synchronous `charge-refused` records and SQLite `perStep`, Host, replay and tooling consumers, shared executable-catalogue activation, and the shared Trace/Session expectations and first blessing below. Zig's legacy SQLite catalogue replay remains until that coordinated activation. Current support is documented beside the [Go](../../impl/go/README.md#ordinary-capability-operations), [TS](../../impl/ts/README.md#process-wide-core-and-host-manifests) and [Zig](../../impl/zig/README.md#the-machine) APIs.
- **Approval still needed:** no new expectation files have been created or blessed. Future Trace and Session expectations require their first blessing under the [corpus workflow](../../corpus/README.md#checking); execution agreement is not approval.

**Delivery decision for #911 (2026-10-14):** the maintainer authorized Zig to lead with Zig-only tests while Go/TS and the shared metering catalogues remain staged. This permits the Zig runtime, C API, Message Layer, replay consumers and SQLite step factory to ship together. `spec/embedding/talk.go`, `spec/embedding/talk.ts`, `spec/data/corpus.toml`, `spec/data/stdlib.toml`, their shared consumers and generated output, and shared expectation changes remain for coordinated activation. First blessing of future shared expectations remains a separate approval.

Required sections: declaration/effect safety and synchronous authorization; asynchronous admission, cancellation and fault location; accounting and saves; Trace/message-layer records; SQLite step authorization. Chapters 5–11 and Session observation link or reconcile those rules. Do not treat the prose or public declaration changes as runtime support.

## Implementation sequence

1. Add declaration metadata, validation, manifests/fingerprints and native APIs. Add pending-call source positions, request identity/counter, retained issued-call eligibility, one-outstanding enforcement, FIFO admission, report/future settlement and terminal cleanup. Preserve queued requests across lifecycle teardown until a Pump resolves them inactive. Activate and match the staged Go/TS declarations and expose the same behavior through the Message Layer and Zig's embedding surface.
2. Implement accounting, saved counter/version changes and Save refusals. Preserve existing early-interruption and timer order. Paid requests remain paid if cancellation lands later in the same Pump. No asynchronous write transaction or synthetic Segment is introduced.
3. Activate the executable Trace and setup catalogues together with parsers, writers, replay backends, case loaders and Session recording/replay. Add cases only once consumers understand them; do not weaken coverage or bless changed expectations merely to make checks pass.
4. Change SQLite factories and every supplied driver to `perStep` and the `beforeStep` callback. Update Go/Bun/Node adapters, test kits, examples and current-support guides together. No standard SQLite Message Layer factory is added by this design; generic metered Operations must work over that layer.

### Deferred Data Files and consumers

- `spec/embedding/talk.go` and `spec/embedding/talk.ts`: apply the [target declarations](../../spec/embedding/metered-operations.md#target-embedding-declarations) with runtime implementation. Their current declarations deliberately retain the existing checked API. This stages the metering field, request/result API and SQLite callback signatures without weakening the API comparison.

- `spec/data/corpus.toml`: add `charge-request` and `charge-result` with the ordered fields in the contract, optional `call.charge-refused`, optional `stub.charge-refused`, optional Operation setup `metering`, and SQLite standard setup `perStep` replacing `perRow` (default 0, old key rejected). Existing generated tables intentionally lack these extensions until implementation. Remove the staging notices in chapters 11 and the metering contract when activated.
- `spec/data/stdlib.toml`: add SQLite query/change metering metadata together with its schema and factory/catalogue consumers. Preserve the other SQLite declarations. This delivery does not change active Standard Capability tables.
- Regenerate Spec output and Go/Zig tables when those catalogues change; update TS consumers and tooling manifest readers. `trace.ebnf` needs no syntax extension: its record grammar already permits the new names and fields. Existing `invalid value`, `unknown call` and `effects pending` codes suffice.
- Keep the Go API comparison passing when activating the new request/result types, Operation field and SQLite callback signatures. Do not add exemptions for staging. Review snapshot format versions and manifest compatibility when implementing persisted counters and metadata.

## Acceptance matrix

| Area | Required evidence |
| --- | --- |
| Declarations | Omission preserves legacy up-front calls; validate both values, mode/effect/scope combinations, missing coordinator and fire-and-forget rejection. Manifest/fingerprint changes on metering changes, not documentation edits. |
| Synchronous charging | Several accepted chunks, zero, exact exhaustion, refused first charge and refused suffix; refused amount is never counted. Suppressed refusal and later return/error/charge cannot clear the fault. Result/error conversion and rollback retain accepted Fuel. |
| Admission | One outstanding request per call; invalid amount/mode/overlap allocate no id. Ids and issued-call eligibility survive a permitted Save; stale native and Message Layer calls agree. TS async run may await a request, while synchronous callbacks cannot block. Inactive calls receive outcomes with no debit. Futures settle exactly once at Pump end and match reports. |
| Shared budgets | Two Join Members compete in FIFO order; first unaffordable request ends their Run and abandons siblings. Later requests are inactive. Other Runs continue. Refusal while the Join body is preempted rolls back its still-open Segment without creating a Stretch. Fault location identifies the originating member, with no synthetic Segment. |
| Races | Both orderings of request versus Answer/Fail/Stop/cancel; existing early interruption; accepted request then due timeout in the same Pump; revocation does not independently cancel in-flight calls. Reload before drain still permits inactive outcome delivery. Acceptance never renews deadlines or refunds Fuel. |
| Accounting | Accepted increments appear immediately in Run accounting, Script counters and Pump FuelUsed even without execution. Cap/slice overrun during queue drain becomes normal debt. Waiting-only Pumps need no runnable continuation. Late answer costs add only unpaid work. Cancellation cleanup preserves its existing allowance. |
| Saves | Refuse with no input drain for pending metered calls and unresolved requests after their call ends. Check refused Trace output and later successful save after settlement. No metered pending call can be adopted/reissued from a new snapshot. |
| Replay and transport | Synchronous accepted prefix plus refusal reproduces totals and outcome with and without Stubs. Check zero prefix, malformed Stub combinations, synchronously rejected requests (including invalid amounts), asynchronous input/outcome order, inactive outcomes and charge-only Pumps. Native and Message Layer results agree; stale local fuelLeft cannot fund post-start work. Session recordings preserve these inputs. |
| SQLite | Empty result, N rows plus completion, max=0, overflow probe, SQL-error step, zero rate, exact Fuel and refusal before completion/overflow. Non-returning change pays a step. Driver never steps after callback refusal; Segment rollback undoes all provisional writes. Parameter/result charges and ordinary failed-call atomicity remain intact. |

Run focused native API, driver-kit, replay, message-layer and cross-Core cases in Go, TS and Zig as support lands. Public accounting requires API assertions independently of Trace equality. Compare changed existing SQLite expectations against the new step counts before first blessing.

The planning inspection identified a **possible, unverified Zig discrepancy**: ordinary `Call.charge` refusal may not latch, and `.limited` may discard previously accepted totals (`impl/zig/src/machine/capabilities.zig` and `machine.zig`). Verify with focused tests. If confirmed, open and link the cross-Core issue during implementation under the [issue conventions](../agents/issue-tracker.md#cross-core-findings); this documentation task publishes no tracker changes.

## Specification validation

The original API comparison failure was reproduced both in PR #723 CI and with `go -C impl/go test ./internal/apicheck`: `Operation.Metering` and the Query/Change callback signatures had been activated before implementation. The target declarations now live in the metering contract until implementation; the API comparison and runtime code are unchanged.

- Verified on 2026-10-13: `go -C impl/go test ./internal/apicheck`, the full `go -C impl/go test ./...` suite, `bun run check`, `bun run go:check`, and `git diff --check` pass.
- No runtime, SQLite driver, new Trace Case or Session expectation has been implemented or blessed by this specification delivery.

## Specification file set

```text
GLOSSARY.md
changelog/unreleased/metered-operations.md
docs/adr/README.md
docs/adr/0049-live-host-effects-prevent-saving.md
docs/adr/0070-sqlite-is-an-optional-standard-capability-with-segment-bound-writes.md
docs/adr/0082-metered-operations-authorize-work-through-the-pump.md
docs/handoffs/472-metered-operations.md
docs/sqlite.md
impl/go/README.md
impl/ts/README.md
impl/zig/README.md
spec/README.md
spec/05-handlers-messages-and-scheduling.md
spec/06-errors-and-limits.md
spec/07-libraries-and-the-standard-library.md
spec/08-the-abstract-machine-and-the-cost-model.md
spec/09-embedding.md
spec/10-save-and-restore.md
spec/11-the-trace-and-conformance.md
spec/appendix-a-glossary.md
spec/data/host-errors.toml
spec/embedding/metered-operations.md
spec/embedding/scoped-effects.md
spec/embedding/talk.go
spec/embedding/talk.ts
spec/session-observation.md
```
