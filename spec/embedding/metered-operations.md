# Metered Operations

This is the normative incremental charging contract of [chapter 9](../09-embedding.md#metered-operations), decided in [ADR 0082](../../docs/adr/0082-metered-operations-authorize-work-through-the-pump.md). The [implementation handoff](../../docs/handoffs/472-metered-operations.md) identifies deferred executable catalogues and acceptance work. The record/setup extensions and target embedding declarations below take precedence over the older generated tables and checked interface files for this feature until implementation activates them together.

## Declarations and effect safety

An Operation Declaration may contain `metering: "read-only"` or `metering: "segment-bound"`. Omission preserves the existing up-front charging contract; it does not authorize interleaving work with charges or asynchronous charge requests.

- `read-only` permits immediate and suspending Operations and promises no externally observable writes. Private buffers and disposable read resources are allowed. It cannot be combined with `segmentBound: true` or scope lifecycle metadata.
- `segment-bound` requires immediate mode and `segmentBound: true`, including the existing coordinator requirements. Every effect remains provisional until the Segment's outcome. Scope lifecycle metadata retains its existing rules.
- Fire-and-forget Operations cannot be metered. Invalid combinations or unknown metering values are Host Error `invalid value` at definition. The Core checks declarations; the Host is responsible for honoring their effect guarantees.
- The Host Manifest, Message Layer and `case.toml` carry `metering`. In canonical Operation key order it follows `segmentBound` and precedes tooling documentation. It participates in the Group Fingerprint and restore declaration matching; omission is distinct from either value.

Metering adds no Script syntax. It does not create transactions across suspension: suspension commits the old Segment, and asynchronous metering is read-only. A Capability Scope alone is not rollback protection. Automatic abandonment and lifecycle hooks cannot request or consume Script Fuel.

## Synchronous authorization

`Charge(fuel)` remains synchronous and legal only during the Script call's Host callback. A Metered Operation may call it repeatedly, before each bounded chunk of work. It must stop at the first refusal, before performing that chunk. A successful increment is retained even if the chunk or the Operation later fails, its result conversion faults, or its Segment rolls back. Declared call costs and result conversion costs still apply independently.

An increment that fits the remaining Run allowance succeeds, including exact exhaustion and zero. An increment that does not fit contributes zero Fuel and latches a Limit Fault at the call; suppressing the returned error, throwing another error, returning a value or attempting another charge cannot clear it. Prior accepted increments remain charged. During cancellation cleanup, the existing Cleanup Budget applies instead. Unmarked Operations retain their existing ability to make up-front `Charge` calls before doing work.

Fuel amounts are whole numbers from 0 through 9,007,199,254,740,991. Invalid amounts are Host Error `invalid value`, not budget refusal. Metering is cooperative Host enforcement: the Core cannot interrupt an arbitrary Host loop or undo a Host's violation of its declaration.

## Asynchronous authorization

`Call.RequestCharge(fuel)` in Go and `call.requestCharge(fuel)` in TS enqueue a charge request into the Group that created the Call. They are safe from any goroutine / outside the Pump, trigger `OnReady`, and return immediately with a request identity and future. They are available only to suspending Operations declared `metering: "read-only"`; a request may be queued during their starting callback, but a synchronous Go/TS `start` callback must not block waiting for it. TS Promise-backed `run` may use `await call.requestCharge(fuel).result`: yielding its Promise returns control to the Core so a later Pump can process the request.

Each call permits one unresolved request. Invalid amounts, ineligible calls, automatic calls and overlapping requests are Host Error `invalid value` synchronously, allocating no request identity. An eligible Call retained after settlement may still queue a request; it receives `inactive` when drained. The Core retains metering eligibility for issued call ids for the Group lifetime, including across successful saves/restores. Thus the Message Layer accepts a previously issued eligible id for an inactive outcome just as a retained native Call does, rejects an issued ineligible id as `invalid value`, and rejects a never-issued id as `unknown call`. Validate eligibility and amount, then overlap, before assigning an id.

Request ids are Group-wide `q1`, `q2`, … in successful enqueue order. The counter survives saves; synchronous enqueue refusal allocates no id. A future exposes its id immediately and settles exactly once, at the end of the Pump that processes it. Its result is also returned as a `charge result` report with `request`, `call`, `fuel` (the requested amount) and `status`:

- `accepted`: the call is pending and its Run can pay the whole amount. Deduct it immediately. The Host may perform the next chunk only after receiving this result and checking the call's cancellation signal/context.
- `limit`: the call is pending but its Run cannot pay. Deduct nothing for this request and end the entire Run with a Fuel Limit Fault. Abandon every pending call, including sibling Join Members; no `catch` or `finally` runs.
- `inactive`: the call is no longer pending when this input is processed. Deduct nothing and do not fault a Run.

The outstanding slot clears when the future settles. All admitted requests eventually receive an outcome when the Host pumps, even if Reload, Stop or another lifecycle boundary ended their call first; do not discard their queued inputs or leave their futures unresolved. Worker lifecycle calls leave these requests queued for a later Pump, where they become inactive.

### Ordering, cancellation and fault location

The Pump takes its Clock and input batch as usual. Charge requests join ordinary FIFO input order, including Answer, Fail and cancellation inputs. Concurrent Join Members share one Run allowance: whichever request drains first spends first. Existing early Stop/cancel/rewind landing rules remain in force. Later arrivals wait for the next Pump.

An accepted outcome is immutable. A later input or a due timer in the same Pump can end the call before the future settles; Fuel is still spent. Hosts must observe cancellation before starting another chunk and stop when abandoned. Acceptance is not immunity from cancellation and does not renew `maxPending` or `MaxWait`. Charge requests drain before due timers under the existing Pump ordering.

A `limit` outcome faults at the saved source position of the originating Operation call (the particular member for a Join). The fault is processed when the Pump drains the request, before Script scheduling. A suspended Run has no executing Segment to undo: retain already committed Script Variables and Host effects, create no synthetic Segment or Stretch, and emit no synthetic `seg` record. A pending Join Member can also belong to a Run preempted before the Join closes. In that case its existing open Segment is rolled back, including Script Variables and its participant. There is still no executing Stretch to finish, so emit fault, cleanup and terminal records without inventing a `seg` or resuming Script code. The normal fault, abandonment and terminal reporting rules apply, including sender failure. Other Runs continue.

`AnswerWithCost` / `answer(value, {fuel})` remain available for additional costs not already paid through metering, charged on resume. The Host must not bill the same work twice. Answering settles the call under existing rules; a subsequent charge request is inactive even if the answer's Run has not resumed.

## Accounting and saves

Accepted charges immediately update Run Fuel, Script counters, the processing Pump's FuelUsed and that Script's slice usage. Run accounting emits its cumulative replacement in that Pump's accounting tail, even if no Segment executes. Refused and inactive requests contribute zero. Accepted Fuel is never refunded by rollback, Stop, Reload, cancellation or failure.

As with Reissue work during input draining, the input batch drains before scheduling checks the Pump Fuel cap and Script slice. Charges can exceed those scheduling allowances, but never their Run allowance; normal slice debt carries forward. Do not manufacture a runnable continuation or `sliced` outcome for a Group whose Runs all remain waiting. No additional Fuel is charged for request bookkeeping, reporting or future settlement.

Save returns `effects pending` if any asynchronous metered call remains pending or any charge request is unresolved, including one whose call was ended outside a Pump. It drains nothing and produces no snapshot. Thus no work permission or waiting charge future is saved, adopted or reissued. Settled metering counters, issued-call metering eligibility and the next request id are saved normally. Existing snapshot version and fingerprint compatibility rules apply; implementations must version any changed persisted layout.

## Trace and message layer

`corpus.toml` carries these records and the optional Operation setup `metering` key, with the declaration values above. SQLite `[standard]` setup takes `perStep` (default 0) in place of `perRow`, which runners reject rather than silently reading as a step rate. These are the required ordered Trace fields:

| Record | Direction | Positional ids | Ordered fields |
| --- | --- | --- | --- |
| `charge-request` | Host Input | call, optional request | `fuel` (value: valid whole Fuel, or `"invalid"` for an invalid amount) |
| `charge-result` | Core output | call, request | `fuel` (count), `status` (`accepted`, `limit`, `inactive`) |
| `call` extension | Core output | unchanged | optional `charge-refused=yes`, immediately after `charged` and before `automatic` |
| `stub` extension | runner input | unchanged | optional `charge-refused=yes`, immediately after `charge` |

Queued `charge-request` lines appear before their `pump` input in queue order; outcomes appear after `pump` in drain-output order, before any Stretch. Write `charge-result status=limit` before the resulting `fault`, cleanup and `run` records. Report the same outcome in the Pump's report list at that drain point, before resulting terminal reports; the cumulative accounting tail stays last. A synchronously refused request writes `> charge-request <call> fuel=<amount>` with no trailing request id, followed by ordinary `refused`; a queued request writes `> charge-request <call> <request> fuel=<amount>`. Normalize any invalid amount to the text `"invalid"`, which replay feeds to enqueue validation to reproduce `invalid value` without preserving native non-values such as NaN. Valid amounts remain numbers even for overlap or eligibility refusal. The absent request id makes this synchronous refusal form unambiguous; it never receives `charge-result`. Replay validates sequential request ids and recomputes outcomes from the recorded order and budgets.

For synchronous callbacks, `call.charged` remains the sum of accepted increments only; omit it when zero. `charge-refused=yes` means an additional increment was refused, and excludes both result and error. It is required even when no increment succeeded. Never include the refused amount in `charged`. No individual synchronous increments are recorded.

A Stub without `charge-refused` retains its existing single-charge behavior, including a possible refusal. With `charge-refused=yes`, its `charge` is the accepted prefix total (zero when absent), which must fit; then simulate a refused increment without doing work. `value` and `error` must be absent. Live-Trace replay uses the same accepted-prefix-plus-refusal behavior; it must not mistake a successfully paid prefix for a successful whole call. No simulated increment may overflow the Fuel amount representation. Replay may inject the refusal directly through its Host adapter. Ordinary automatic-abandonment Stubs cannot charge or refuse a charge.

The Message Layer adds `request-charge` with `call` and `fuel`; its immediate `ok` reply contains `request`, acknowledging enqueue only. A later `pump` report has `kind: "charge result"`, `request`, `call`, `fuel`, `status`. Host glue settles its local future from that report. During a synchronous `op`, keep subtracting local `fuelLeft` before each chunk; latch refusal and send `{limit: true, charged: <accepted total>}` even if the callback suppressed refusal. The Core records `charge-refused=yes`. Successful replies cannot override a latched refusal. Never reuse `fuelLeft` after replying `started`: subsequent work requires `request-charge` and a later Pump outcome. The existing transport `ref` is distinct from the Core-assigned request id.

## Target embedding declarations

These declarations are the normative implementation target. The checked `talk.ts` and `talk.go` carry all of these declarations, which the TS Core and the Go API implement, so the API comparison verifies them without exemptions.

In Go, add `Metering string` to `Operation` immediately after `SegmentBound`. Its values are empty, `"read-only"` and `"segment-bound"`, validated as above. Add the following request and report types; `ChargeResult` implements `Report`:

```go
func (c *Call) RequestCharge(fuel int64) (*ChargeRequest, error)

type ChargeRequestID string

type ChargeRequest struct { /* opaque */ }

func (r *ChargeRequest) ID() ChargeRequestID
func (r *ChargeRequest) Done() <-chan struct{}
func (r *ChargeRequest) Result() *ChargeResult // read after Done closes at Pump end

type ChargeResult struct {
    Request ChargeRequestID
    Call    CallID
    Fuel    int64 // requested amount; only accepted contributes Fuel
    Status  string // "accepted", "limit" or "inactive"
}

func (*ChargeResult) isReport()
```

Replace the Go SQLite implementation interface and factory signature with:

```go
type SqliteImpl interface {
    Coordinator(database string) *SegmentLifecycle
    Query(c *Call, sql string, params SqlParams, max int64, beforeStep func() error) (SqlRows, error)
    Change(c *Call, sql string, params SqlParams, max int64, beforeStep func() error) (SqlRows, error)
    Begin(c *Call) error
    Commit(c *Call) error
    Rollback(c *Call) error
}

func (c *Core) SqliteCapability(impl SqliteImpl, costs Costs, perStep int64) (*CapabilityDef, error)
```

In TS, add `metering?: "read-only" | "segment-bound"` to `ImmediateOp` and `metering?: "read-only"` to `SuspendingOp`; `FireOp` has no metering member. Add `requestCharge(fuel: number): ChargeRequest` to `Call<B>`, and include `ChargeResult` in the `Report` union:

```ts
export interface ChargeRequest {
  readonly id: string;
  readonly result: Promise<ChargeResult>; // settles at the processing Pump's end
}
export interface ChargeResult {
  readonly kind: "charge result";
  readonly request: string;
  readonly call: string;
  readonly fuel: number; // requested amount; only accepted contributes Fuel
  readonly status: "accepted" | "limit" | "inactive";
}
```

Replace the TS SQLite implementation interface with:

```ts
export interface SqliteImpl {
  coordinator(database: string): SegmentCoordinator;
  query(call: Call<SqliteBinding>, sql: string, params: SqlParams, max: number, beforeStep: () => void): SqlRows;
  change(call: Call<SqliteBinding>, sql: string, params: SqlParams, max: number, beforeStep: () => void): SqlRows & { readonly changes: number };
  begin(call: Call<SqliteBinding>): void;
  commit(call: Call<SqliteBinding>): void;
  rollback(call: Call<SqliteBinding>): void;
}
```

The TS Core factory becomes `sqliteCapability(impl: SqliteImpl, costs: Costs, perStep: number): CapabilityDef<SqliteBinding>`. Both factories supply the `beforeStep` callback as specified below. The existing `Charge`, `AnswerWithCost`/`answer`, and Save signatures stay unchanged; their metering behavior follows this contract rather than the legacy comments in the staged interface files.

## SQLite step authorization

The factory takes `perStep`, a whole nonnegative Fuel cost in the same range as other costs, and declares `query` as `metering: "read-only"` and `change` as `metering: "segment-bound"`. Both remain immediate. Other SQLite Operations keep their existing declarations and costs.

The factory supplies a `beforeStep` callback to the implementation's Query and Change methods. It invokes the Call's `Charge(perStep)`; the implementation must invoke it exactly once immediately before every SQLite statement step and propagate refusal without stepping. The factory owns the rate, and the driver owns the stepping loop. There is no `max × perRow` reservation or refund.

This includes the first step, the final completion check, a step that reports a SQL error, and the probe that detects more than `max` rows. With N returned rows and successful completion there are normally N+1 charged steps. An empty result costs one step. `max=0` still permits a completion step; a row from it raises `too many rows`. A non-returning change also pays its execution step. A refused probe is a Limit Fault before overflow can be detected. All earlier paid steps remain charged.

Declared call cost, parameter handling and result conversion/allocation remain independent. Row limits still reject excess results rather than truncate them. A write-side refusal rolls back the Segment, including prior provisional writes; ordinary SQL errors retain the existing failed-call atomicity rules. Query does not enroll a participant solely to meter reads. A step may perform a large scan or update before returning; this is step accounting, not a bound on SQL VM instructions, CPU time or affected rows.
