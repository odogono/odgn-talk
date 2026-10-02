# Capability Scopes and Segment-bound Operations

This is the normative lifecycle contract used by [chapter 9](../09-embedding.md), the [Go](talk.go) and [TS](talk.ts) embedding declarations, and [chapter 11](../11-the-trace-and-conformance.md). [ADR 0047](../../docs/adr/0047-capability-scopes-guarantee-abandonment-not-atomicity.md), [ADR 0048](../../docs/adr/0048-segment-bound-effects-use-one-host-participant.md) and [ADR 0049](../../docs/adr/0049-live-host-effects-prevent-saving.md) explain the choices. Core implementation and executable conformance cases are separate work from this specification.

## Declarations

An Operation Declaration may add `scope` and `segmentBound`. Their JSON and TOML forms are identical in meaning:

```toml
[[operations]]
capability = "db"
name = "begin"
mode = "immediate"
args = []
result = "nothing"
cost = { fuel = 1 }
scope = { opens = "transaction", abandon = "rollback" }
segmentBound = true

[[operations]]
capability = "db"
name = "commit"
mode = "immediate"
args = []
result = "nothing"
cost = { fuel = 1 }
scope = { closes = "transaction" }
segmentBound = true

[[operations]]
capability = "db"
name = "rollback"
mode = "immediate"
args = []
result = "nothing"
cost = { fuel = 1 }
scope = { closes = "transaction" }
segmentBound = true
```

- `scope` is absent, exactly `{opens, abandon}`, or exactly `{closes}`. Names are nonempty identifier words, compared as Operation names are. The abandonment name refers to an Operation on the same Capability, closing the same scope, with no arguments and result Shape `nothing`. All openers of a scope name specify the same abandonment Operation.
- Opening, closing and abandonment Operations must be immediate. `segmentBound` defaults to false and can be true only for an immediate Operation. All lifecycle Operations for one scope name must agree on `segmentBound`; ordinary Operations such as `change` or `write` declare it independently.
- A Capability offering any Segment-bound Operation supplies all three synchronous lifecycle hooks. TS passes an optional lifecycle object to `defineCapability`; Go uses `DefineSegmentCapability` with the same Operations plus hooks. Ordinary `DefineCapability` is unchanged. Invalid metadata, a missing target, inconsistent scope declarations or missing hooks is Host Error `invalid value` at definition.
- Grant creation requires the abandonment Operation for every opener it includes; absence is `invalid value`. `GrantsAsUsed` retains that dependency even without a Script call to it. Implicit retention does not add any other Operation to the allowlist. Explicit Script calls to retained abandonment Operations obey normal permission, Shape and charging rules.
- The Host Manifest, Message Layer declarations and `case.toml` carry the same metadata. The Group Fingerprint includes it but excludes hooks, bindings, open scopes, participant state and disabled status. Canonical Operation keys append optional `scope`, then `segmentBound: true`; false is omitted. An opening scope writes `opens`, then `abandon`; a closing scope writes `closes`.

## Scope ownership and calls

A slot is identified by Script, Run, named Grant and scope name. At most one instance occupies it. Different Grant aliases are different slots, even with the same Host binding. Opening an occupied slot raises `scope already open`; closing an empty slot raises `scope not open`. Explicit closes may occur in any order. A scope may be closed and reopened later in the same Run.

Before entering the Host, apply normal Grant and argument checks, then scope checks, then participant-conflict checks, then normal call charges. Rejected calls allocate no call id and perform no Host work. The new checks consume no additional Fuel beyond the normal charged instruction/error machinery. The scope errors carry the named Grant as `capability`, the Operation name as `operation`, and the scope name as `scope`.

A Host Call exposes its `group` identity (the Group instance, not just its name), `runId`, `grantName`, the current `segmentId`, and, for a lifecycle Operation, `scopeName`; `automatic` is false for Script calls. The Host retains the acquired handle or opener arguments under that identity. Native Hosts use Group object identity as the outer namespace; Message Layer Hosts use the enclosing Group handle. Group names alone need not be unique. Copying or reusing a Grant template never shares the Core's scope bookkeeping.

A normal Host return acknowledges acquisition or closure immediately, before checking or converting its result and before observing queued Stop or cancellation. Even a malformed returned result can therefore raise `host error` with the acquisition already registered. A failed opener must have acquired nothing; a failed closer must leave its scope open and usable for abandonment. A Host that cannot meet these requirements cannot offer that lifecycle Operation. Host success followed by a result-conversion Limit Fault still triggers abandonment of the newly opened scope; a successful close is not repeated after a conversion failure.

The Host must isolate each Run's resources across preemption, other Scripts, Groups and shared bindings. The Core does not lock a connection or make unrelated calls transactional. Host rejection of an incompatible resource use is an ordinary declared Operation error.

## Suspension and preemption

With any scope open, reaching `wait`, `wait for`, a suspending Operation, a waiting send or cross-Script Function Value call, or entering a Join raises catchable `scope open` before registering waits, sending messages or starting Host work. This includes zero-duration waits and empty Joins. The error identifies the most recently opened surviving scope, with `capability` and `scope` fields.

A local Handler or Function Value called with `and wait` may run until its executed path reaches such a boundary. Entering that local call alone does not fail. Opening a scope while executing inside a Join, including through nested local calls, raises `scope in join` before acquisition, even before the Join starts any members. Its fields are `capability`, `operation` and `scope`.

Fuel Slice and Group Fuel cap preemption remain unchanged. Scope and participant bookkeeping survives it; another Script can execute. [Save](../10-save-and-restore.md#saving) refuses the Group while either is live. Neither a preemption nor an empty Join finalizes a participant.

## Automatic abandonment

Whenever a Run ends with slots occupied, attempt each abandonment once in reverse successful-opening order, before its outcome, reply, Verdict or replacement becomes visible and before another Run is scheduled. This applies to completion, ordinary error, Limit Fault, cancellation, Stop, owner disposal, Reload and library replacement. Abandonment is a Host call, never Script code and never a `finally` block.

The Core uses the saved Grant binding and abandonment implementation even after revocation or disablement. It supplies a fresh Call id, the same ownership context, `automatic: true`, an empty argument list and a fresh, non-cancelled signal/context. It does not charge the Operation's declared cost, result conversion, allocation, Cleanup Budget or `FuelTotal`. `Charge` is not available for automatic cleanup (attempting it is a Host contract failure of that abandonment); `Answer` and `Fail` cannot settle it. Hosts must bound this synchronous work. Cleanup cannot open scopes or enlist a new participant and cannot reenter worker calls.

On success, remove the slot. On failure, report `effect failure`, disable that Script's named Grant, remove the slot from the Core's active bookkeeping and continue remaining abandonment attempts; it is not retried automatically. This removal does not assert that the external resource was released. A future Script call through that Grant raises `capability disabled`. If revoked too, `capability disabled` takes precedence. Explicit close failures remain ordinary Operation errors and leave the slot open; disablement is for failed automatic abandonment.

Disabling affects only this named Grant on this Script. The Host must quarantine aliases and other Scripts sharing its binding. Disabled state survives full and variables-only restore, Reload and library replacement, and remains visible in Grant inspection. There is no reset API: repair the resource and load a fresh Script. Save may succeed once no active scopes or participant remain, even when a disabled Grant represents unresolved Host cleanup.

## Segment participant

The participant is the Script's named Grant, not the identity of its opaque binding. The first Segment-bound call, after checks and charges but before its Operation executes, invokes `begin` once. A second participating Grant raises `segment participant conflict` with fields `capability` (requested Grant), `operation` and `participant` (existing Grant), before the second call is charged or enters the Host. Several Operations on the same Grant share the participant.

The hooks receive Group identity, binding, Script name, Run id, Grant name, Segment id and the last observed Clock. Segment ids are `<run>.s<N>`, counting actual Segments from 1, including a cancellation cleanup Segment; preemption does not advance N. Hooks return one of `ok`, `failed` or `unknown`, with an optional Host-only detail string. `failed` means definite non-commit for commit, no acquisition for begin, and unsuccessful rollback for rollback. `unknown`, an exception/panic or malformed return is an uncertain Host contract failure. A failed begin raises catchable `host error` at the enrolling Operation, reports the failure, leaves no participant and does not call that Operation; its already charged costs remain spent. An unknown begin stops the Group and attempts rollback of the possibly acquired participant.

Hooks have no Script result, argument conversion or Script cost. The participant is enrolled before executing its first Operation and remains enrolled even if that Operation returns an ordinary error. Hooks cannot make worker calls or perform further Script execution. They may queue inputs, but finalization is indivisible with respect to those inputs: a Stop or cancellation queued by a successful commit is observed only after that Segment is finalized.

| Segment boundary | Host action |
| --- | --- |
| Completion, `return`, `pass`, `veto`, uncaught ordinary error | Run Script `finally`/unwind and all boundary charges and Persistent State checks; abandon leftover scopes; then commit if these steps permit it |
| Actual suspension without an open scope | Commit after boundary checks, before publishing suspension or sealing a Verdict; a started unrelated suspending call remains outside the transaction |
| Caught error or preemption | No finalization |
| Limit Fault, Stop, disposal, successful Reload or replacement | Abandon scopes, then roll back the current participant; no Script `finally` |
| Cancellation | Abandon scopes on the participating Grant, roll back that participant and Script Variables, then run `finally` as a fresh cleanup Segment; abandon other remaining scopes when cleanup ends |
| Cleanup Segment succeeds or ends with ordinary error | Commit its participant after abandoning remaining scopes |
| Cleanup Segment exceeds a limit or is stopped | Abandon remaining scopes and roll back its participant |

An explicit scope close on the participating Grant operates within the participant: a transaction `commit` may release a savepoint but cannot publish effects beyond the enclosing Segment. Scope abandonment also operates within it. Failed abandonment on that Grant prevents a would-be commit and invokes rollback instead. Abandonment on an unrelated Grant reports and disables it without changing the participant's decision.

A `commit` returning `failed` causes participant rollback and restoration of the Script Variables' Segment base. No Script `catch`, `finally` or `error` Handler executes for this failure. The Run ends `effect failed`, including when its cleanup Segment was about to commit; the report identifies the phase and Grant. Pending calls and Join Members are abandoned. Senders receive `send failed`, reason `effect failed`; an unsealed Decision is undecided. Successful rollback leaves the Grant usable unless it was disabled by abandonment. A would-be commit prevented by failed participating abandonment has the same outcome. Existing Limit Fault, cancellation or Stop outcomes are retained when abandonment fails during an already-required rollback.

An unknown commit or any unsuccessful rollback reports the failure, attempts remaining cleanup and stops every Script in the Group with reason `effect state unknown`, in Script load order and Run start order. Never retry commit; attempt rollback once where a participant may remain. A failed rollback itself is not retried. This stop is sticky for the Group: Load, Reload, Extend and ReplaceLibrary return Host Error `effect state unknown`; they cannot resume it. The Host must recover externally and create a new Group; saving this terminal Group also returns `effects pending`, because external state is unresolved.

The guarantee covers Script Variables and this participant only. Messages, property writes and unrelated immediate/fire-and-forget effects remain final. Ordinary errors commit, so resource abandonment that discards an unclosed inner transaction does not mean every Script assignment corresponds to a database change. There is no distributed transaction or process-crash/power-loss recovery guarantee.

## Lifecycle outside a Pump

Reload and library replacement validate and check carried state before terminating old Runs. CarryVariables uses a side-effect-free view of the prospective post-rollback Script Variable bindings, not a preempted Segment's provisional writes; library replacement computes this view for every affected Script before any termination. Validation failure invokes no lifecycle calls. Successful termination performs abandonment and rollback before publishing replacement or returning reports; use the Group's last Clock reading, without consulting wall time. A fatal lifecycle failure stops the Group and prevents replacement; already performed external cleanup is not undone. Reentry from a lifecycle callback is refused as `reentrant call`, outside a Pump too.

No successful snapshot has a live scope or participant, so Restore and Settle acquire no new responsibilities for these resources. Disabled Grant state still restores. The Message Layer carries lifecycle requests as interim replies to `pump`, `reload` or `replace-library` under the initiating `ref`; final replies wait until all cleanup exchanges complete.

## Worked examples

### Database transfer

```talk
on transfer fromId, toId, amount
  ask db to begin
  ask db to change "update accounts set balance = balance - ? where id = ?", [amount, fromId]
  if the changes of it is 0 then throw {code: "no account", id: fromId}
  ask db to change "update accounts set balance = balance + ? where id = ?", [amount, toId]
  ask db to commit
end transfer
```

With only scope metadata, an unclosed transaction is abandoned, but an explicit commit stays committed after a later Limit Fault. With `segmentBound = true` on the lifecycle Operations and `change`, the Host begins an outer transaction in the hook; the Script's begin/commit/rollback operate on an inner savepoint. Final publication happens only in the Segment commit hook. An ordinary error with an open inner scope abandons that scope before committing the outer participant.

### File-handle cleanup

A Host declares immediate `open` with `scope = {opens = "file", abandon = "close"}`, `write` with no scope metadata, and zero-argument `close` returning Nothing with `scope = {closes = "file"}`. None is Segment-bound.

```talk
on export text
  ask output to open "report.txt"
  ask output to write text
  ask output to close
end export
```

The Host keeps the handle under the Run/Grant/scope identity. Unexpected Run termination attempts close. Successful writes survive a later fault: handle cleanup is not byte rollback. Only one file can be open at a time through this slot; closing permits opening another.

### Staged single-file publication

The same Script can use a Host whose `open`, `write` and `close` are all Segment-bound. Its begin hook starts staging; `open` creates a temporary file, `write` writes it, and `close` closes the handle without publication. Commit publishes one staged destination; rollback discards the staged file. Automatic abandonment closes and discards an unfinished file, so the subsequent ordinary-error Segment commit publishes nothing for it. The Host rejects an attempt to stage a second destination in the same Segment before changing it.

A fault after explicit close discards the staged contents. The Host must provide definite publication outcomes and atomic single-destination replacement for its storage system; an ambiguous publication stops the Group. Several simultaneously open files, multiple destinations and recovery after a process crash require a different Host contract and are outside v1.
