# 10. Save and restore

_Draws on:_ [ADR 0005](../docs/adr/0005-durability-is-a-deferred-extension.md), [ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md), [ADR 0008](../docs/adr/0008-same-core-save-restore.md), [ADR 0014](../docs/adr/0014-a-session-is-an-ordinary-host.md), [ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md), [ADR 0018](../docs/adr/0018-the-trace-is-the-corpus-case.md), [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md), [ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md), [ADR 0031](../docs/adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md), [ADR 0038](../docs/adr/0038-settling-a-restored-call-is-a-queued-host-input.md), [#71](https://github.com/odogono/odgn-talk/issues/71), [#72](https://github.com/odogono/odgn-talk/issues/72), [ADR 0060](../docs/adr/0060-errors-may-transfer-to-named-recovery-offers-chosen-before-unwinding.md).

A Host can save a whole Group between Pumps and restore it later on the same Core family. It can also change a loaded Script's code, by reloading it or by extending it. This chapter states what each keeps and what each discards.

## The rule

Catch dispatch can be saved at any instruction boundary, including ordinary catch tests, policy, pending transfer cleanup and action entry. The saved state preserves retained failure control and shared owner locals, without changing the save-format compatibility or live-effect refusal rules.

**Pending addition:** [Store Notification checkpoints](proposals/store-notifications.md#checkpoints) pair a Group save with the Host's watch routing state and Store revisions, so that a full restore reinstates watches and a changed Store resyncs them. Neither Core's router exists yet; a save still holds no watches.

**Save then restore is unobservable** ([ADR 0008](../docs/adr/0008-same-core-save-restore.md)). A restored Group, given the same later Host Inputs, Clock readings and Fuel Slices, gives the same results and reports, and the same Trace apart from the save and restore records, as the Group that was never saved. It uses the same Fuel and faults at the same instruction. Resetting any counter would let a Script launder Fuel through a save.

- **Same Core family only:** a save from the TS Core never restores on the Go Core, and the other way round. The format is each Core's own, and there is no stable cross-Core format ([ADR 0005](../docs/adr/0005-durability-is-a-deferred-extension.md)).
- **Checked on every case:** every Conformance Corpus case is also replayed with a save and a restore between each pair of Pumps where Save succeeds; live-effect boundaries instead check `effects pending` refusal and continue the original Group, and both paths must give identical execution output ([ADR 0018](../docs/adr/0018-the-trace-is-the-corpus-case.md), [chapter 11](11-the-trace-and-conformance.md)).

## Saving

- **When:** `Save` is a worker call, attempted whenever the Group is Quiescent, which is always between Pumps. If any Capability Scope or Segment participant is live, or fatal effect uncertainty stopped the Group, it returns Host Error `effects pending`, produces no snapshot and does not drain inputs, close resources or advance execution ([ADR 0049](../docs/adr/0049-live-host-effects-prevent-saving.md)). A save can only be attempted during a Pump from inside it, which is the Host error `reentrant call`. The Core has no notion of paused.
- **Preempted Runs** can be saved when they hold no live scopes or participants. A Run a Fuel Slice or the Group's Fuel cap cut mid-Segment is saved mid-Segment, with its segment base, so a later Limit Fault still rolls it back correctly ([ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md)).
- **Unobservable:** saving charges nothing and changes only the Trace save id counter. A successful save appears in the Trace only as a `save` record; a refused attempt writes `save` then `refused code="effects pending"`, allocating an attempt id but no restorable snapshot ([chapter 11](11-the-trace-and-conformance.md)).
- **The bytes:** the same complete Group state, including its Trace save id counter, gives the same bytes on the same Core version. Consecutive saves advance that counter and therefore differ; saving never changes Script state or scheduling.

### What a save holds

A save holds all of [the machine's state](08-the-abstract-machine-and-the-cost-model.md#the-machines-state), as plain data:

- **The Group:** its name, its Scripts in load order, the identity of each of its Libraries, the last Clock reading, and the counters that assign delivery ids, Broadcast ids, run ids, call ids and Trace save ids.
- **The input queue:** every Host Input queued since the last Pump, in call order, with the delivery id each was given. A Host Input only a Host function could make, such as `Answer` from one, is saved like any other.
- **Each Broadcast in progress:** its id, its recipients, and for a Broadcast Decision, which recipients have sealed and the vetoes so far ([chapter 5](05-handlers-messages-and-scheduling.md#decisions)).
- **The versions:** the language version, the Cost Model version, the save-format version and the Group Fingerprint ([chapter 9](09-embedding.md#the-pump-and-the-group-fingerprint)).
- **Each Script:**
  - its name, its source and each extension's source, its limits, and its Grants by name, each with its Capability's name and its kept Operations
  - its owner and its well-known objects, by Host Object id
  - its Script Variables, its definitions' values, its mailbox and work queue in order, and each clause's queue of parked Runs
  - its counters (`FuelTotal`, `AllocTotal`, `Runs`, `Faults`) and its Persistent State size
  - its Fuel Slice debt, the Grants the Host has revoked or disabled, and whether it has been stopped
  - each message in its mailbox with its delivery id, its limit override and the reply it owes, if any
- **Each Run:** everything [chapter 8](08-the-abstract-machine-and-the-cost-model.md#the-machines-state) lists, including:
  - its frames, each with its code position (a code unit's identity, a body and a pc), its locals and its operand stack
  - its run id, its status, its limits with its Delivery's override applied, the Fuel and allocation it has used, and the Cleanup Budget it has spent
  - its segment base and Segment ordinal, its Delivery and open Verdict, and its dispatch in progress
  - the reply it owes: to the Run waiting in a `send … and wait` or a Function Value call, or to the Host's `Request`, `Call` or `Decide`
  - the reply it waits for, if it waits in a `send … and wait` or a Function Value call to another Script
  - its wait, with each deadline as an absolute Instant and its place in the order waits began
  - its pending calls, and its Join's members with the answers that have arrived
  - its dispatch-context stack, retained continuations, activation PCs and operand stacks, owning-frame identities and shared locals, the try being dispatched and selection boundaries
  - its pending acceptance or offer target and evaluated arguments, cleanup queue and progress, inherited/entered scope identities, and per-Run offer-attempt counter
  - its cleanup stack
- **Each pending call:** its call id, its Run, its Grant name and Operation, its arguments and its `maxPending` or `MaxWait` deadline. Its declared cost has always been charged by then. In TS it also records whether the original call used `start` or `run`, which decides Adopt eligibility independently of the rebound Host implementation.
- **Each Host Object:** its kind, its id, its parent, and whether it is disposed. Native objects are never saved.
- **Function Values:** their Home Script, body and captured values, as plain data ([ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md)).
- **Text Patterns:** their canonical source, and no compiled program.

### What a save leaves out

- **Anything the Host holds:** native objects, Grant bindings, Host function state, Trace sinks and `OnReady`. Tooling-only debugger callbacks, pauses and breakpoints are not saved.
- **Stores:** a `store` Grant's Store belongs to the Host, so restoring an older save can leave Script Variables and the Store disagreeing ([ADR 0050](../docs/adr/0050-the-store-is-a-standard-capability-with-segment-bound-writes.md)). A save can't be taken while a Segment's Store writes are uncommitted, as for any live participant ([ADR 0049](../docs/adr/0049-live-host-effects-prevent-saving.md)).
- **Futures:** a `Request`, `Call` or `Decide` the Host is waiting on has a delivery id in the save, but its future belongs to the old Group. After a restore, the Host learns the outcome from the `run end` or `decided` report with that delivery id.
- **Other Groups:** a save covers exactly one Group. A Delivery already made into another Group, and messages already sent outside it, aren't part of it.

## Restoring

`Core.Restore(save, options)` builds a new Group from a save. It hasn't been pumped, and it is ready for Host Inputs. Restoring takes these steps, in order, and if any step fails, nothing is made:

1. **Reading:** each Core reads exactly its own supported private format version, with no automatic snapshot migration. A save this Core can't read, from another Core family, a save format it no longer reads, or corrupt bytes, is the Host error `invalid save`.
2. **Libraries:** the Host passes compiled Libraries for the saved identities. The Core matches them by identity, and a Library it needs that isn't given is a mismatch.
3. **Grants:** disabled status is preserved, including with variables-only policy, independently of rebinding. The Host's `Grants` function re-binds each Script's Grants, by the Script's name and the Grant's name. A Grant whose Capability, or kept Operations' declarations, differ from the saved ones is a mismatch. Only the saved Operation set is retained; additional Operations the Host offers, and their declarations, are ignored. A Grant the Host doesn't return is restored as revoked, so a call through it raises `capability revoked`. It still binds its name, so the Script still loads, in a variables-only restore too. The Core reconstructs all saved source units before applying revocation state, so an existing extension may still call a revoked Grant. It keeps its saved Capability and declarations for step 4, so on its own it never makes a mismatch.
4. **Versions:** the Core computes the Group Fingerprint from the saved Scripts and limits, the Libraries and Grants from steps 2 and 3, and its own language and Cost Model versions. If it equals the saved one and the save-format version is its own, the restore is **full**. Otherwise it is a mismatch, and the Host's `Mismatch` policy decides: `RejectMismatch` fails with the Host error `save mismatch`, and `VariablesOnly` does a [variables-only restore](#variables-only-restore).
5. **Control validation:** before accepting saved dispatch control, validate code identities, body/table/PC references, phase consistency, owner-local layouts and shared storage, pending target argument counts and slots, cleanup references/progress/scope identities, monotonic attempt counters and acyclic ownership/continuations. Malformed state is `invalid save`. Reconstruct aliases only from validated ownership.
6. **Host Objects:** the Host's `Resolve` function turns each saved `(kind, id)` into a native object. An id it can't resolve restores as a disposed Host Object, and its `[kind, id]` is listed in the result's `Disposed`. The Host gets each restored handle back with `group.ObjectByID(kind, id)` ([chapter 9](09-embedding.md#host-objects)).
7. **Text Patterns** are recompiled from their source, charging nothing.
8. **Pending calls** are returned for the Host to settle ([below](#settling-pending-calls)).

`Restore` returns the Group and a result holding whether the restore was variables-only, the pending calls, the Host Objects that didn't resolve, and for a variables-only restore, what it discarded ([below](#variables-only-restore)).

- **The Clock:** the first Pump after a restore must read a Clock at or after the saved reading, or it is the Host error `clock backwards`. A game Host resumes at the saved game time. Waits whose deadlines have passed fire in that Pump, in deadline order, and of equal deadlines, in the order they began ([chapter 5](05-handlers-messages-and-scheduling.md#a-pump)).
- **Fuel Slices:** each Script's debt carries into the first Pump, so a Run preempted before the save resumes exactly where it would have.
- **In the Trace:** a restore is a `restore` record holding the save's Group Fingerprint, whether it was variables-only, what it discarded and the disposed Host Objects. Each settlement is a Host Input, recorded when the first Pump drains it.

### Settling pending calls

Each pending call is a suspending Operation call that hadn't been answered when the save was made. The Host settles each one with `Group.Settle(callID, settlement)`, a queued call ([chapter 9](09-embedding.md#threads-and-the-input-queue)), before the first Pump, with exactly one of these:

- **Answer:** the call succeeds with the value, as `Answer` would. Converting it is charged when the Run resumes.
- **Fail:** the call fails with the error, as `Fail` would.
- **Reissue:** the Operation's `Start` runs again, with the saved arguments and binding, under the same call id. It runs when the first Pump drains the settlement, so `Now` is that Pump's Clock reading. Its declared cost isn't charged again, since it was charged before the save. `Charge` draws Fuel from the Run as it would at the call, counts toward that Pump's Fuel cap and the Script's Fuel Slice and debt, and converting the answer is charged as usual.
- **Revocation and reissue:** a saved pending call remains in flight even if its Grant was revoked. If the Host re-binds that Grant, Reissue still starts that same call; revocation continues to block later Script calls. If the Host doesn't re-bind it, Reissue fails the pending call with `capability revoked` without reaching a Host implementation. This absence is determined anew by each Restore, separate from saved revocation state.
- **Adopt:** the Host still has the call in progress, and will answer it under the same call id. It costs nothing. `Settle` returns a new `Call` for it, which the Host answers or fails through. A TS `run` call can't be adopted, since its Promise belonged to the old Group, and adopting one is the Host error `not adoptable`.

- **In order:** the settlements are Host Inputs, queued, and drained by the first Pump in the order they were made, at step 2 ([chapter 5](05-handlers-messages-and-scheduling.md#a-pump)). Then every call still unsettled fails in its Script with `call lost`, in call id order (Script name first, then numeric Run counter, then numeric call counter), before any timer fires. The pending and abandoned call lists use this order too. So an unsettled call is `call lost` even when its deadline has also passed.
- **Deadlines:** a settled call's `maxPending` or `MaxWait` deadline keeps its saved Instant. A reissued or adopted call overdue at the first Pump times out at step 3, unless it has been answered by then.
- **Misuse:** settling a call id that isn't pending, settling one twice, or settling once the first Pump has started, is the Host error `unknown call`. Each is known at the call, so `Settle` returns it, and nothing is queued.

- **Joins:** each member is settled on its own. A Join still waits for all its members, and one member's failure fails the Join as usual ([chapter 5](05-handlers-messages-and-scheduling.md#joins)).
- **Fire-and-forget and immediate calls** never pend, so they never need settling.

### Across Scripts

- **Inside the save:** a `send … and wait`, a Function Value call to another Script, or a Decision between Scripts of the saved Group, restores intact, both ends together.
- **Never outside:** Scripts send only within their own Group, and a save covers the whole Group, so every partner is inside it.
- **Deliveries from the Host:** a `Request`, `Call` or `Decide` in flight keeps its delivery id, and its Run reports as usual. Only the future is gone ([What a save leaves out](#what-a-save-leaves-out)).

## Variables-only restore

A variables-only restore rebuilds each Script from its saved source and then each of its extensions in the order they were made, against the Core's current versions, the Libraries given and the Grants re-bound, and keeps only its Script Variables. It follows the Reload rule, [carrying variables over](#carrying-variables-over) for every Script at once.

- **Kept:** each Script's Script Variables whose names it still declares, its counters, its owner and well-known objects, its limits, and its revoked and disabled Grants. Host Objects are kept, and resolved as for a full restore.
- **Discarded:** every Run, suspended, parked or preempted, the mailbox, the work queue, the input queue, each Broadcast in progress and the Fuel Slice debt. Runs are discarded with no `finally`. The result lists the discarded Runs in `DiscardedRuns`, the dropped Deliveries (the mailboxes' and the input queue's) in `DroppedMessages`, and the abandoned calls in `AbandonedCalls`, so the Host can cancel the ones it still has. `Pending` is empty.
- **Late answers:** an answer or failure for an abandoned call is recorded and ignored, as for any call that isn't pending ([chapter 9](09-embedding.md#capabilities)). A Host reaches the restored Group with one only over the message layer, since a `Call` from before the save answers into the Group that made it.
- **Reported:** these lists are the report, as a `stop` report's are, so no discarded Run has a `run end`. The one exception is a Decision: the first Pump gives a `decided` report for each open Decision that was discarded or dropped, with each unsealed recipient undecided, `cancelled`, naming its Script and its Run if it had begun. A Broadcast keeps already sealed ballots and aggregates them by the ordinary Verdict rule; a dropped Broadcast not yet given recipients is undecided with empty lists. These deferred reports are saved if the Host saves again before the first Pump ([ADR 0031](../docs/adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md)).
- **Function Values** are kept, but they are stale: calling one raises `function gone` ([chapter 3](03-values.md#function-values)).
- **Failing as a whole:** if any Script no longer loads, the restore fails with its `LoadError`. If any Script's carried-over Script Variables would exceed its Persistent State cap, the restore fails with the Host error `state too large`. Either way, nothing is made.
- **Id counters** carry over, so no delivery id, run id or call id is reused.
- **The Clock** rule still applies, since the last Clock reading is kept.

## Reload and extend

A Host changes a loaded Script's code in one of two ways ([ADR 0005](../docs/adr/0005-durability-is-a-deferred-extension.md), [ADR 0014](../docs/adr/0014-a-session-is-an-ordinary-host.md)). Each is a worker call, and a Host Input recorded in the Trace.

- **Kept by both:** the Script's name, its place in the Group's load order, its owner, its well-known objects, its Grants and their revocations, its limits and its counters. `FuelTotal` and the other counters carry on from where they were.

### Reload

`Script.Reload(source, carry)` is stop-and-reload.

1. **Checking:** the new source is loaded against the Script's Grants, Libraries and well-known objects, and its initialiser runs, into new Script Variables. A LoadError leaves the Script unchanged.
2. **Carrying:** with `ResetVariables`, the Script Variables are the new initialiser's values. With `CarryVariables`, they are [carried over](#carrying-variables-over) from the prospective post-rollback bindings: use an active Segment's base for variables it would restore when the old Run stops. Compute and validate this view without yet changing the old Run or calling the Host. A carry that would exceed the Persistent State cap is the Host error `state too large`, and leaves the Script unchanged.
3. **Stopping:** only now, the Script is stopped as Stop Script is ([chapter 6](06-errors-and-limits.md#cancellation-and-stop)), with reason `reload`. Its running, parked and suspended Runs are discarded with no `finally`, the messages in its mailbox are dropped, and their senders get `send failed`, reason `stopped`. Pending calls and live scopes are abandoned, and the current participant is rolled back before replacement. Disabled Grants remain disabled. A fatal lifecycle failure stops the Group and prevents replacement; completed external cleanup is not undone. The `stop` report lists what was discarded.
4. **Replacing:** the new code and Script Variables replace the old, all at once. Every Function Value whose Home Script is this Script becomes stale.

`Reload` returns the reports for the Runs it discarded. Unlike Stop Script, it isn't sticky: the reloaded Script takes new messages at once.

- **Replacing a Library** stop-and-reloads every Script that imports it, directly or through another Library, as one Reload each, all in one Host Input ([chapter 7](07-libraries-and-the-standard-library.md#registering-identity-and-replacing)). If any of them fails to load, nothing changes.

### Carrying variables over

- **By name:** after the new initialiser runs, each Script Variable that the old code and the new code both declare takes its old value from the prospective post-rollback view. A stopped preempted Run's provisional writes are not carried into new code. A variables-only restore applies the same rule to discarded active Segments. One the new code doesn't declare is dropped, and one only the new code declares keeps its initial value.
- **As they are:** a value is carried as it is, whatever its kind. A carried Function Value whose Home Script is the reloaded Script is stale.
- **The cap:** the Script's Persistent State, measured with the carried values, must fit its cap ([chapter 6](06-errors-and-limits.md#limits)).

### Extend Script

`Script.Extend(source)` adds new names to a Script without touching its running code ([#71](https://github.com/odogono/odgn-talk/issues/71)). The source is an Entry: Handlers, functions, Script Variables, Constants and `use` lines.

- **Only new names:** an Entry that declares a name the Script already has, including a Handler of the same name, is the Host error `name reused`, and the Host reloads instead. An Entry can't add Grants or well-known objects, which belong to loading.
- **As a code unit:** the Entry is compiled as a new code unit of the Script, an extension, whose names resolve to the Script's existing ones as well as its own. Its initialiser runs for its new Script Variables and Constants. A LoadError leaves the Script unchanged.
- **The cap:** before the extension applies, the Script Variables it adds and everything the Script already keeps must fit the Persistent State cap. Otherwise the Host error is `state too large`, and the Script is unchanged.
- **Nothing stops:** Runs, the mailbox and pending calls carry on, and Function Values stay valid, since no existing code unit changes.
- **Code identity:** the extension's own code identity is computed as a Script's is, with kind `extension`, the Script's name, and the Libraries its `use` lines import. The extended Script's code identity is then the SHA-256 of the UTF-8 text of three lines, each ended by LF: the previous identity in lowercase hexadecimal, `extend`, and the extension's identity in lowercase hexadecimal ([chapter 9](09-embedding.md#the-pump-and-the-group-fingerprint)). So the Group Fingerprint changes, while Function Values made before stay valid.
- **A Reload** replaces the Script and all its extensions with the one new source.

## Host errors

These are the Host errors this chapter adds to [the catalogue](09-embedding.md#host-error-catalogue): `invalid save`, `save mismatch`, `unknown call`, `state too large` and `effects pending`. `reentrant call`, `clock backwards`, `name reused` and `not adoptable` are the ones already there.

## Outside parity

- **The save's bytes:** the format is each Core family's own, and only its behaviour on restore is normative. A save is deterministic on one Core.
- **Storage:** where the Host keeps a save, and whether it compresses or encrypts it.
- **Futures:** how a Host reconnects its own waiting code to a restored Group's reports.
