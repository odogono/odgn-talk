# 10. Save and restore

_Draws on:_ [ADR 0005](../docs/adr/0005-durability-is-a-deferred-extension.md), [ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md), [ADR 0008](../docs/adr/0008-same-core-save-restore.md), [ADR 0014](../docs/adr/0014-a-session-is-an-ordinary-host.md), [ADR 0015](../docs/adr/0015-the-host-drives-the-core-through-a-pump.md), [ADR 0018](../docs/adr/0018-the-trace-is-the-corpus-case.md), [ADR 0020](../docs/adr/0020-scripts-share-code-through-stateless-libraries.md), [ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md), [ADR 0026](../docs/adr/0026-a-join-starts-several-calls-from-one-run-and-suspends-once.md), [ADR 0031](../docs/adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md), [ADR 0038](../docs/adr/0038-settling-a-restored-call-is-a-queued-host-input.md), [#71](https://github.com/odogono/odgn-talk/issues/71), [#72](https://github.com/odogono/odgn-talk/issues/72), [ADR 0060](../docs/adr/0060-errors-may-transfer-to-named-recovery-offers-chosen-before-unwinding.md), [ADR 0073](../docs/adr/0073-a-timeout-block-sets-one-deadline-for-the-waits-written-inside-it.md), [ADR 0144](../docs/adr/0144-a-save-restores-on-either-core.md).

A Host can save a whole Group between Pumps and restore it later on any Core, whichever Core saved it. It can also change a loaded Script's code, by reloading it or by extending it. This chapter states what each keeps and what each discards.

## The rule

Catch dispatch can be saved at any instruction boundary, including ordinary catch tests, policy, pending transfer cleanup and action entry. The saved state preserves retained failure control and shared owner locals, without changing the save-format compatibility or live-effect refusal rules.

**Save then restore is unobservable** ([ADR 0008](../docs/adr/0008-same-core-save-restore.md)). A restored Group, given the same later Host Inputs, Clock readings and Fuel Slices, gives the same results and reports, and the same Trace apart from the save and restore records, as the Group that was never saved. It uses the same Fuel and faults at the same instruction. Resetting any counter would let a Script launder Fuel through a save.

- **On any Core:** every Core writes and reads [the save format](#the-save-format), so a save from the TS Core restores on the Zig Core, and the other way round, as if it had never left the Core that took it ([ADR 0144](../docs/adr/0144-a-save-restores-on-either-core.md)).
- **Checked on every case:** every Conformance Corpus case is also replayed with a save and a restore between each pair of Pumps where Save succeeds; live-effect boundaries instead check `effects pending` refusal and continue the original Group, and both paths must give identical execution output. Each save is also restored on the other Core, which must continue identically and give the same State Fingerprint ([ADR 0018](../docs/adr/0018-the-trace-is-the-corpus-case.md), [chapter 11](11-the-trace-and-conformance.md#cross-core-replays)).

## Saving

- **When:** `Save` is a worker call, attempted whenever the Group is Quiescent, which is always between Pumps. If any Capability Scope or Segment participant is live, an asynchronous metered call is pending, a charge request is unresolved (even after its call ends), or fatal effect uncertainty stopped the Group, it returns Host Error `effects pending`, produces no snapshot and does not drain inputs, close resources or advance execution ([ADR 0049](../docs/adr/0049-live-host-effects-prevent-saving.md)). A save can only be attempted during a Pump from inside it, which is the Host error `reentrant call`. The Core has no notion of paused.
- **Preempted Runs** can be saved when they hold no live scopes or participants. A Run a Fuel Slice or the Group's Fuel cap cut mid-Segment is saved mid-Segment, with its segment base, so a later Limit Fault still rolls it back correctly ([ADR 0006](../docs/adr/0006-limit-faults-roll-back-the-segment.md)).
- **Unobservable:** saving charges nothing and changes only the Trace save id counter. A successful save appears in the Trace only as a `save` record; a refused attempt writes `save` then `refused code="effects pending"`, allocating an attempt id but no restorable snapshot ([chapter 11](11-the-trace-and-conformance.md)).
- **The bytes:** the same complete Group state, including its Trace save id counter, gives the same bytes on every Core. Consecutive saves advance that counter and therefore differ; saving never changes Script state or scheduling.

### The State Fingerprint

A **State Fingerprint** lets a Host tell whether two saved Groups are in the same state, which their bytes can't show because each save advances the Trace save id counter ([ADR 0142](../docs/adr/0142-saved-state-is-compared-by-state-fingerprint.md)).

- **Two forms:** `group.stateFingerprint()` gives a live Group's, and `core.stateFingerprint(save)` gives a save's. Each is 32 bytes. The second equals the first taken from the Group a full restore of that save would rebuild, without restoring it.
- **What it covers:** everything [a save holds](#what-a-save-holds) except the Trace save id counter. Code counts by its identity, so an Embedded-source and an External-source Snapshot of the same state give the same fingerprint. Host Objects count by kind, id, parent and disposal, never by native handle, so a restored Group's fingerprint equals its save's.
- **What it leaves out:** the Trace save id counter, and anything [a save leaves out](#what-a-save-leaves-out). A Session Host's observation state is saved beside the Group, not in it, so it is never covered.
- **The guarantee:** on one save-format version, two Groups have the same State Fingerprint exactly when everything it covers is equal, whichever Core holds them. So two saves with nothing run between them give the same fingerprint, as does a save, its restore on either Core and a save of that restore. Fingerprints from different save-format versions are not comparable.
- **How it is computed:** it is the SHA-256 of each required section's tag byte and digest, in tag order, and a save carries it in [its header](#the-header). So `core.stateFingerprint(save)` checks the body digest and reads 32 bytes, without decoding the sections.
- **Unobservable:** taking it charges nothing, changes no state or counter, and writes no Trace record. The live form follows the rules for [when a save can be attempted](#saving): it is a worker call, `reentrant call` during a Pump, and `effects pending` when a save would be refused. The save form fails with `invalid save` for bytes the Core can't read, and `save mismatch` for a save of another save-format version.

### Accounting and Session observations

A save preserves [Run accounting](09-embedding.md#run-accounting) ancestry on live Runs and queued messages, root discard counts, creation/admission order and accounting observations not yet returned. A Restore returns its specified accounting baseline, including exact saved Fuel for Runs discarded by VariablesOnly. It does not re-emit already-returned dispatch events or reset Fuel.

A Session Host saves its observation state alongside the Group: filters, latched trace pairs, Fuel Measurements, retained defining-source documentation and its implicit Entry counter. [The Session restore rules](session-observation.md#save-and-restore) replace that state on restore and keep abandoned future totals separate. Captured object identities use the Host resolver; saving does not snapshot arbitrary native getter state.

### What a save holds

A save holds all of [the machine's state](08-the-abstract-machine-and-the-cost-model.md#the-machines-state), as plain data:

- **The Group:** its name, its Scripts in load order, the identity of each of its Libraries, the last Clock reading, the state of its [`random` generator](07-libraries-and-the-standard-library.md#random-numbers), and the counters that assign delivery ids, Broadcast ids, run ids, call ids and Trace save ids.
- **The input queue:** every Host Input queued since the last Pump, in call order, with the delivery id each was given. A Host Input only a Host function could make, such as `Answer` from one, is saved like any other.
- **Each Broadcast in progress:** its id, its recipients, and for a Broadcast Decision, which recipients have sealed and the vetoes so far ([chapter 5](05-handlers-messages-and-scheduling.md#decisions)).
- **The versions:** the language version, the Cost Model version, the save-format version and the Group Fingerprint ([chapter 9](09-embedding.md#the-pump-and-the-group-fingerprint)).
- **Each Script:**
  - its name, its source and each extension's source (or only their identities in an [External-source Snapshot](#source-modes)), its limits, and its Grants by name, each with its Capability's name and its kept Operations
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
  - the deadline of each Timeout Block it is inside, as an absolute Instant ([chapter 5](05-handlers-messages-and-scheduling.md#timeout-blocks))
  - its pending calls, and its Join's members with the answers that have arrived and each member's optional Result Target (the owning frame and local slot, or Script Variable index)
  - its dispatch-context stack, retained continuations, activation PCs and operand stacks, owning-frame identities and shared locals, the try being dispatched and selection boundaries
  - its pending acceptance or offer target and evaluated arguments, cleanup queue and progress, inherited/entered scope identities, and per-Run offer-attempt counter
  - its cleanup stack
  - each active, retained and cleanup frame's inherited restricted-callback flag
- **Each pending call:** its call id, its Run, its Grant name and Operation, its arguments and its `maxPending` or `MaxWait` deadline. Its declared cost has always been charged by then. It also records whether the original call used `start` or `run`, which decides Adopt eligibility independently of the rebound Host implementation.
- **Each Host Object:** its kind, its id, its parent, and whether it is disposed. Native objects are never saved.
- **Function Values:** their Home Script, body and captured values, as plain data ([ADR 0025](../docs/adr/0025-lambdas-are-first-class-function-values-that-run-in-their-home-script.md)).
- **Text Patterns:** their canonical source, and no compiled program.

### What a save leaves out

- **Anything the Host holds:** native objects, Grant bindings, Host function state, Trace sinks and `OnReady`. Tooling-only debugger callbacks, pauses and breakpoints are not saved.
- **Watches:** a Core save holds no watches or router-pending Notifications. A Host that offers `watch` uses [Store Notification checkpoints](#store-notification-checkpoints) to save that state beside the Group. Already admitted Notifications are ordinary saved Deliveries.
- **Stores:** a `store` Grant's Store belongs to the Host, so restoring an older save can leave Script Variables and the Store disagreeing ([ADR 0050](../docs/adr/0050-the-store-is-a-standard-capability-with-segment-bound-writes.md)). A save can't be taken while a Segment's Store writes are uncommitted, as for any live participant ([ADR 0049](../docs/adr/0049-live-host-effects-prevent-saving.md)).
- **Metering:** save restrictions prevent a pending metered call or unresolved charging future from entering a snapshot. Save the next Group-wide charge request id and all accepted accounting normally; declaration matching includes `metering` ([contract](embedding/metered-operations.md#accounting-and-saves)).
- **Futures:** a `Request`, `Call` or `Decide` the Host is waiting on has a delivery id in the save, but its future belongs to the old Group. After a restore, the Host learns the outcome from the `run end` or `decided` report with that delivery id.
- **Other Groups:** a save covers exactly one Group. A Delivery already made into another Group, and messages already sent outside it, aren't part of it.

### Source modes

A save stores sources in one of two modes ([ADR 0111](../docs/adr/0111-snapshot-sources-may-come-from-the-host.md)): an Embedded-source Snapshot has the optional `sources` section, and an External-source Snapshot leaves it out. The two differ in nothing else, so they give the same State Fingerprint. In the native TS Core, `group.save()` and
`group.save({sources: 'embedded'})` produce an Embedded-source Snapshot.
`group.save({sources: 'external'})` produces an External-source Snapshot:
it holds each Script's ordered base and extension identities instead of their
sources. Libraries already come from the Host by identity in either mode.
Go, Zig, their Message Layer and `@northtalk/ts/wasm` write only
Embedded-source Snapshots and offer no `scriptSources` option, so they restore
an External-source Snapshot only as a missing bundle.

To restore external sources, the Host supplies the synchronous
`scriptSources({name, identities})` option. It returns `{source, extensions?}`,
with extensions in application order. The Core loads these units against the
supplied Libraries and Grants and recomputes every identity, including exact
source text and imported Library identities, before accepting a continuation.
An embedded-source restore uses its saved sources and never calls this option.

A missing callback or `undefined` bundle fails the whole Restore with
`save mismatch`, even with variables-only policy. Different code also rejects
under `onMismatch: 'reject'`. With `onMismatch: 'variables only'`, supplied
replacement code may instead initialize the whole Group and carry variables
by name from the saved prospective post-rollback bindings. This discards every
Script's continuations, including those whose code matched, and returns the
ordinary discarded Runs, dropped messages, abandoned calls and accounting
reports. Carried Function Values are stale. No source is silently substituted
for a full continuation. A replacement that does not load or exceeds the state
cap fails atomically, as for other variables-only restores. A Host may then
apply its ordinary Reload policy; removed Scripts require an explicit
replacement bundle rather than disappearing during Restore.

Both modes retain all execution state and saved Grant declarations, including
the declarations needed to compile an unbound, revoked Grant. Source storage
changes no Fuel, accounting, settlement or live-effect rules.

The native TS router forwards `router.save(group, options)` to Group Save and
ties its routing state to those bytes as usual. Restore receives the same
`scriptSources` option through the existing checkpoint options. Session saves
keep embedded sources by default.

## The save format

Every Core writes a save as these bytes and reads them back, so a save restores on either Core ([ADR 0144](../docs/adr/0144-a-save-restores-on-either-core.md)). The format holds exactly [what a save holds](#what-a-save-holds), and its tables come from [`save-format.toml`](data/save-format.toml). Code is never saved: a restore compiles each unit again from its source and checks its identity before it trusts a single code position, so a saved body and pc mean the same thing on every Core because [chapter 8's lowering](08-the-abstract-machine-and-the-cost-model.md) is exact.

### Encoding

A save is a header followed by sections. Every integer is LEB128, and every digest is SHA-256. A field's type is one of these, a record or union below, `list of T` (a `uint` count, then that many T), or `optional T` (a `bool`, then T when it is true).

<!-- generated: save-format.primitives -->

| Type | Encoding |
| --- | --- |
| `magic` | Four bytes, the `[format]` magic. |
| `byte` | One byte. |
| `bool` | One byte: 0 for false and 1 for true. Any other byte is `invalid save`. |
| `uint` | An unsigned LEB128 integer, in its shortest form. |
| `sint` | A signed LEB128 integer, in its shortest form. |
| `text` | A `uint` byte length, then that many bytes of UTF-8. |
| `bytes` | A `uint` length, then that many bytes. |
| `raw` | Bytes whose length an earlier field gives. |
| `digest` | 32 bytes: a SHA-256 digest or a code identity. |
| `index` | A `uint` position in a list this save already holds, counting from 0. |
| `name` | A `uint` position in the `texts` section's `texts`. |
| `ref` | A `uint`: 0 for none, or a position in a list this save already holds plus 1. |

<!-- end -->

A writer uses the shortest LEB128 form, writes each list in the order its field gives, and never writes a section it has nothing to put in unless the section is required. So the same state gives the same bytes on every Core.

### The header

<!-- generated: save-format.header -->

| Field | Type | Is |
| --- | --- | --- |
| magic | `magic` | The bytes `NTSV`. |
| format | `uint` | The save format version. |
| language | `text` | The language version. |
| cost model | `uint` | The Cost Model version. |
| group fingerprint | `digest` | The Group Fingerprint (chapter 9) the save was taken under. |
| save id counter | `uint` | The Trace save id counter, after this save. |
| state fingerprint | `digest` | The State Fingerprint: the SHA-256 of each required section's tag byte and digest, in tag order. |
| body digest | `digest` | The SHA-256 of every header byte before this field, then each section's tag byte, flag byte and digest, in order. |
| sections | `list of section` | The sections, in ascending tag order. |

<!-- end -->

Each section is framed by the `section` record below, so a reader can find, check or skip it without decoding the others.

### Sections

Sections come in ascending tag order, each at most once. Every required section is present. A reader rejects an unknown required section with `invalid save`, and skips an unknown optional one after checking its digest, so adding an optional section needs no format version bump. Each byte is hashed once: as a section is written its digest is taken, and the State Fingerprint and body digest are computed from those digests.

<!-- generated: save-format.sections -->

#### 1: texts (required)

Every text a `name` field holds, each once.

| Field | Type | Is |
| --- | --- | --- |
| texts | `list of text` | Numbered in the order the writer first meets each text: the other sections in tag order with `functions` last, each one's fields in order, and each value depth-first as written. Two are the same when their bytes are. A shared table entry counts as met where the table holds it. The writer can't know this table until it has written the others, so it writes this section's body last and frames it in tag order. |

#### 2: group (required)

The Group's counters and its record of issued call ids.

| Field | Type | Is |
| --- | --- | --- |
| name | `text` | The Group's name when it was first made. A restored Group writes its save's name here, whatever the Host names it, so its State Fingerprint equals its save's. |
| clock | `instant` | The last Clock reading. |
| deliveries | `uint` | The last Delivery id issued. |
| broadcasts | `uint` | The last Broadcast id issued. |
| timers | `uint` | The timer counter. |
| run order | `uint` | The number of Runs the Group has started, counted at each `run started` report. A Run's `order` is this count when it started. |
| charge counter | `uint` | The charge request counter. |
| random state | `uint` | The Group's random generator state. |
| issued calls | `list of issued` | Each Run's issued call numbers, by Run id in ascending byte order. |

#### 3: libraries (required)

Every Library the Group holds, by identity.

| Field | Type | Is |
| --- | --- | --- |
| libraries | `list of library` | In the Group's order. |

#### 4: objects (required)

Every Host Object the Group has seen, by Object Kind and id.

| Field | Type | Is |
| --- | --- | --- |
| objects | `list of object` | In the order the Group first saw them. A Value's or field's object `index` or `ref` points here. |

#### 5: functions (required)

The code of every Function Value the save holds, and no other.

| Field | Type | Is |
| --- | --- | --- |
| functions | `list of function` | Numbered in the order the writer first meets a Function Value with that code: the other sections in tag order, each one's fields in order, and each value depth-first as written, a Function Value before its captures. A Function Value's `code` points here. The writer can't know this table until it has written the others, so it writes this section's body last and frames it in tag order. |

#### 6: calls (required)

The Suspending Capability calls a Run still waits on.

| Field | Type | Is |
| --- | --- | --- |
| calls | `list of call` | In the order they were made. |

#### 7: scripts (required)

Each Script's identity, limits, Grants, objects, variables and counters.

| Field | Type | Is |
| --- | --- | --- |
| declarations | `list of grant declaration` | Each distinct Grant declaration once, in the order the Grants first meet it: the Scripts in load order, each one's Grants in order. Two are the same when their encoded bytes are. A Grant's `declaration` points here. |
| scripts | `list of script` | In load order. |

#### 8: runs (required)

Every live Run, Script by Script, in each Script's live order.

| Field | Type | Is |
| --- | --- | --- |
| per script | `list of uint` | How many Runs each Script has, one per Script. It comes first, so a reader knows each Run's Script before it reads the Run's code positions. |
| bases | `list of segment base` | Each distinct segment base once, in the order the Runs in `runs` first meet it. Two are the same when their encoded bytes are. A Run's `segment base` points here, and a Function Value in a base is met here, before `runs`. |
| runs | `list of run` | The first Script's Runs, then the next Script's, in `scripts` order. A Run's `index` counts across this whole list. |

#### 9: work (required)

Each Script's queued work.

| Field | Type | Is |
| --- | --- | --- |
| work | `list of script work` | One per Script, in `scripts` order. |

#### 10: waits (required)

Every pending wait, with a deadline or not, in the order they were set.

| Field | Type | Is |
| --- | --- | --- |
| waits | `list of deadline wait` | Every Run's and Join Member's `pending`, in the order the waits were set. |

#### 11: inputs (required)

The Host inputs queued for the next Pump.

| Field | Type | Is |
| --- | --- | --- |
| inputs | `list of input` | In queue order. |

#### 12: decisions (required)

Broadcast Decisions some recipient hasn't sealed, and those a variables-only restore left for the first Pump.

| Field | Type | Is |
| --- | --- | --- |
| open | `list of open broadcast` | By Broadcast id, ascending. |
| deferred | `list of deferred decision` | In the order they were deferred. |

#### 13: accounting (required)

Run accounting: each root's discarded messages, and the roots whose work changed since the last report (chapter 9).

| Field | Type | Is |
| --- | --- | --- |
| discards | `list of root discards` | By root id, ascending. |
| changed roots | `list of uint` | In the order they changed. |

#### 14: sources (optional)

Each Script's base and extension sources, in an Embedded-source Snapshot.

| Field | Type | Is |
| --- | --- | --- |
| sources | `list of script sources` | One per Script, in `scripts` order. |

<!-- end -->

### Unions

A union is written as its variant's tag byte, then that variant's fields in order.

<!-- generated: save-format.unions -->

#### value

A Script value. Text and Map values carry a mark byte: bit 0 for a core message, bit 1 for a Script name, every other bit clear.

| Tag | Variant | Is | Then |
| --- | --- | --- | --- |
| 0 | nothing | Nothing. |  |
| 1 | boolean | A Boolean. | value: `bool` |
| 2 | number | A Number. | number: `decimal` |
| 3 | quantity | A Quantity. | number: `decimal`; unit: `name` |
| 4 | text | A Text. | marks: `byte`; text: `text` |
| 5 | bytes | A Bytes. | bytes: `bytes` |
| 6 | list | A List. | items: `list of value` |
| 7 | map | A Map. | marks: `byte`; pairs: `list of pair` |
| 8 | range | A Range. | from: `value`; to: `value` |
| 9 | instant | An Instant. | instant: `instant` |
| 10 | civil date | A civil date. | date: `civil date` |
| 11 | pattern | A Text Pattern. | source: `text` |
| 12 | function | A Function Value. | code: `ref`; display: `name`; home: `name`; captures: `value` |
| 13 | object | A Host Object. | object: `index` |

#### unit

Where a code unit is, relative to a Script.

| Tag | Variant | Is | Then |
| --- | --- | --- | --- |
| 0 | own | The Script's own base unit. |  |
| 1 | extension | One of the Script's extensions. | extension: `uint` |
| 2 | library | A Library the Group holds. | library: `index` |
| 3 | stdlib | A stdlib Library. | name: `name` |

#### slot

An operand stack slot. An iterator, reader or replacement that several slots share is written in full once, the first time, and by position after.

| Tag | Variant | Is | Then |
| --- | --- | --- | --- |
| 0 | value | A value. | value: `value` |
| 1 | iterator | An iterator. | shared: `ref`; iterator: `iterator` |
| 2 | reader | A Bytes reader. | shared: `ref`; reader: `reader` |
| 3 | replacement | A Text Pattern replacement. | shared: `ref`; replacement: `replacement` |
| 4 | deadline | A timeout block's deadline. | at: `sint`; us: `sint` |

#### control

A Run's error control.

| Tag | Variant | Is | Then |
| --- | --- | --- | --- |
| 0 | dispatch | Choosing a handler for an error. | error: `value`; owner: `uint`; place: `uint`; held: `list of frame`; owner stack: `list of slot`; owner pc: `uint`; search: `search` |
| 1 | cleanup | Running cleanups before control moves on. | error: `value`; cleanups: `list of cleanup`; next: `uint`; left: `bool`; failed: `uint`; failed frame: `optional uint`; held: `list of frame`; then: `then` |

#### then

Where control goes after cleanups.

| Tag | Variant | Is | Then |
| --- | --- | --- | --- |
| 0 | accept | On to a handler. | frame: `uint`; pc: `uint`; stack: `list of slot` |
| 1 | end | The Run ends. |  |
| 2 | cancel | The Run is cancelled. |  |
| 3 | transfer | To a named recovery offer. | frame: `uint`; offer entry: `uint`; record: `uint`; offer: `uint`; args: `list of value`; attempt: `uint`; limit: `optional limit` |
| 4 | search | Back to a handler search. | search: `search` |

#### resume

What a Run or Join Member resumes with; tag 0 for nothing yet.

| Tag | Variant | Is | Then |
| --- | --- | --- | --- |
| 0 | none | Nothing yet. |  |
| 1 | answer | An answer. | value: `value`; fuel: `uint` |
| 2 | failed | A `Fail` with a Script error. | failure: `failure` |
| 3 | broken | A failure that wasn't a Script error. | detail: `optional text` |
| 4 | timeout | Its deadline passed. |  |
| 5 | woke | A `wait` ran out. |  |
| 6 | reply | The reply to a `send … and wait`. | value: `value` |
| 7 | event | A `wait for` that fired. | message: `optional value`; branch: `uint`; binds: `uint` |
| 8 | send failed | A `send … and wait` that got no reply. | reason: `text`; error: `optional value` |
| 9 | joined | Every member of its Join answered. |  |
| 10 | join failed | A member of its Join failed. | member: `uint` |
| 11 | unparked | It was unparked. |  |
| 12 | cancelled | It was cancelled. |  |
| 13 | lost | Its call was lost. |  |
| 14 | limited | It hit a limit. |  |
| 15 | revoked | Its Grant was revoked. |  |

#### branch

A `wait for` branch.

| Tag | Variant | Is | Then |
| --- | --- | --- | --- |
| 0 | when | A message branch. | from: `optional value`; captures: `list of value` |
| 1 | after | A timeout branch. | at: `sint` |

#### work

One item of a Script's queued work.

| Tag | Variant | Is | Then |
| --- | --- | --- | --- |
| 0 | message | A message not yet started. | delivery: `delivery` |
| 1 | run | A Run ready to continue. | run: `index` |

#### part

A Decision recipient's part so far.

| Tag | Variant | Is | Then |
| --- | --- | --- | --- |
| 0 | none | Not decided yet. |  |
| 1 | allowed | Allowed. |  |
| 2 | vetoed | Vetoed. | mark: `mark` |
| 3 | undecided | Ended without deciding. | mark: `mark` |

#### input

A queued Host input. A charge request in the queue refuses the save with `effects pending`, so it has no tag.

| Tag | Variant | Is | Then |
| --- | --- | --- | --- |
| 0 | settlement | A restored call's settlement, queued before the first Pump. | id: `name`; how: `byte`; with: `resume` |
| 1 | deliver | A Delivery to a Script. | script: `name`; delivery: `delivery` |
| 2 | set parent | `setParent`. | object: `ref`; parent: `ref` |
| 3 | dispose | `dispose`. | object: `ref` |
| 4 | settle | An answer or failure for a suspending call. | id: `name`; with: `resume` |
| 5 | broadcast | A Broadcast or Broadcast Decision; its recipients are found as the queue drains. | id: `uint`; message: `name`; args: `list of value`; decision: `bool`; limits: `optional override` |
| 6 | revoke | Revoking a Script's Grant. | script: `name`; grant: `name` |
| 7 | cancel run | Cancelling a Run. | run: `name` |
| 8 | rewind run | Rewinding a Run in its first Segment to its message. | run: `name` |
| 9 | stop | Stopping a Script. | script: `name`; reason: `name` |
| 10 | cancel delivery | Cancelling a Delivery. | delivery: `uint` |
| 11 | cancel broadcast | Cancelling a Broadcast. | broadcast: `uint` |

<!-- end -->

### Records

<!-- generated: save-format.records -->

#### section

One section's frame.

| Field | Type | Is |
| --- | --- | --- |
| tag | `byte` | The section's tag. |
| flags | `byte` | Bit 0 set for an optional section; every other bit clear. |
| length | `uint` | The body's length in bytes. |
| digest | `digest` | The SHA-256 of the body. |
| body | `raw` | `length` bytes: the section's fields, in order. Bytes left over after its last field are `invalid save`. |

#### instant

An Instant.

| Field | Type | Is |
| --- | --- | --- |
| seconds | `sint` | Seconds since the Unix epoch. |
| micros | `uint` | Microseconds within the second, below 1000000. |

#### decimal

A Number, exactly as the value holds it, so `1.50` and `1.5` stay distinct.

| Field | Type | Is |
| --- | --- | --- |
| negative | `bool` | Its sign, including a negative zero. |
| coefficient | `uint` | Its coefficient. |
| exponent | `sint` | Its power of ten. |

#### issued

One Run's issued call numbers.

| Field | Type | Is |
| --- | --- | --- |
| run | `name` | The Run's id. |
| ranges | `list of issued range` | Disjoint, ascending, and at least one. |

#### issued range

A run of consecutive call numbers.

| Field | Type | Is |
| --- | --- | --- |
| first | `uint` | The first number. |
| last | `uint` | The last number. |
| eligible | `bool` | Whether these calls may still be settled. |

#### library

A Library, by identity; the Host supplies its code on restore.

| Field | Type | Is |
| --- | --- | --- |
| name | `name` | Its name. |
| version | `name` | Its version. |
| identity | `digest` | Its code identity (chapter 9). |

#### object

A Host Object.

| Field | Type | Is |
| --- | --- | --- |
| kind | `name` | Its Object Kind. |
| id | `name` | Its id. |
| parent | `ref` | Its parent, in `objects`. |
| disposed | `bool` | Whether it is disposed. |
| owner of | `optional name` | The Script it owns, if it is a Script's owner. |

#### function

A Function Value's code. A stale one, whose home Script has since been reloaded, keeps only what it still answers.

| Field | Type | Is |
| --- | --- | --- |
| home | `name` | Its home Script. |
| name | `name` | Its name. |
| required | `uint` | Its required parameter count. |
| total | `uint` | Its total parameter count. |
| unit | `digest` | The code identity of the unit that holds it. |
| body | `optional code position` | Where its body is, if its home Script still has its code. |

#### code position

A code body, relative to a Script.

| Field | Type | Is |
| --- | --- | --- |
| unit | `unit` | The unit. |
| body | `uint` | The body's number in that unit, as chapter 8's lowering numbers them. |

#### call

A Suspending Capability call a Run waits on.

| Field | Type | Is |
| --- | --- | --- |
| id | `name` | Its call id. |
| script | `name` | The Script that made it. |
| grant | `name` | The Grant it went through. |
| run | `name` | The Run that made it. |
| segment | `name` | The Segment it was made in. |
| now | `instant` | The Clock reading it was made at. |
| args | `list of value` | Its arguments. |
| start | `bool` | Whether the Host's Operation took it with `start` rather than `run`, which decides whether the Host may Adopt it. A Core whose Host Operations have no `run` form, such as Zig's, writes true. |
| charged | `uint` | The Fuel charged for it. |
| at unit | `name` | The unit of its call site, where a refused reissue faults. |
| at pc | `uint` | The call site's instruction. |
| at line | `uint` | The call site's line. |
| at column | `uint` | The call site's column. |

#### script

A Script, without its Runs, work or sources.

| Field | Type | Is |
| --- | --- | --- |
| name | `name` | Its name. |
| identity | `digest` | Its base code identity. |
| extensions | `list of digest` | Its extensions' code identities, in order. |
| limits | `list of uint` | Its limits, in `limits.toml` order. |
| grants | `list of grant` | Its Grants, in order. |
| owner | `ref` | Its owner, in `objects`. |
| objects | `list of named object` | Its named Host Objects, in order. |
| variable names | `list of name` | Its Script Variables' names, in declaration order. |
| variables | `list of value` | Its Script Variables' values, in the same order. |
| definitions | `list of value` | Its base unit's definitions, then each extension's, in order. |
| runs | `uint` | Its Run counter. |
| fuel total | `uint` | Its total Fuel used. |
| alloc total | `uint` | Its total Allocation used. |
| faults | `uint` | Its fault count. |
| debt | `uint` | Its Fuel debt. |
| stopped | `optional name` | Why it was stopped, if it was. |

#### grant

A Script's Grant, with what a restore that can't re-bind it still needs to check code against.

| Field | Type | Is |
| --- | --- | --- |
| name | `name` | Its name. |
| declaration | `index` | Its declaration, in the `scripts` section's `declarations`. |
| revoked | `bool` | Whether it is revoked. |
| disabled | `bool` | Whether it is disabled. |

#### grant declaration

What a Grant declares, shared by every Grant that declares the same.

| Field | Type | Is |
| --- | --- | --- |
| declarations | `text` | Its Capability and kept Operations as Host Manifest JSON (chapter 9). |
| capability | `name` | Its Capability's name. |
| operations | `list of operation` | Its kept Operations, in the Capability's order. |

#### segment base

The Script Variables a Segment started from, shared by every Run that started from the same.

| Field | Type | Is |
| --- | --- | --- |
| variables | `list of value` | The Script Variables' values, in declaration order. |

#### operation

An Operation's shape.

| Field | Type | Is |
| --- | --- | --- |
| name | `name` | Its name. |
| mode | `byte` | 0 for `immediate`, 1 for `suspending` and 2 for `fire-and-forget`. Any other byte is `invalid save`. |
| required | `uint` | Its required argument count. |
| args | `uint` | Its total argument count. |
| command | `bool` | Whether it is a command. |
| labels | `list of name` | Its argument labels. |

#### named object

A Script's named Host Object.

| Field | Type | Is |
| --- | --- | --- |
| name | `name` | Its name. |
| object | `ref` | The object, in `objects`. |

#### script sources

One Script's sources.

| Field | Type | Is |
| --- | --- | --- |
| source | `text` | Its base source. |
| extensions | `list of text` | Its extensions' sources, in order. |

#### run

A live Run.

| Field | Type | Is |
| --- | --- | --- |
| id | `name` | Its id. |
| order | `uint` | Its place in the Group's Run order. |
| reported fuel | `optional uint` | The Fuel last reported for it, if any was. |
| fuel | `uint` | The Fuel it has used. |
| alloc | `uint` | The Allocation it has used. |
| delivery | `delivery` | The Delivery it handles. |
| handler | `name` | The Handler it runs. |
| clause | `uint` | The Handler clause it runs. |
| limits | `list of uint` | Its limits, in `limits.toml` order. |
| clause fuel | `uint` | The Fuel used in its current clause. |
| preempted in | `optional preemption` | Where a Fuel Slice preempted it, if one did. |
| continuing | `bool` | Whether it continues past its current clause. |
| clauses seen | `uint` | How many clauses it has tried. |
| cleanup from | `optional uint` | Its Fuel when its cancellation cleanup began, if it is cleaning up. |
| cleanup limited | `bool` | Whether its cleanup hit the cleanup budget. |
| controls | `list of control` | Its error control, innermost last. |
| attempts | `uint` | Its attempt counter. |
| calls | `uint` | Its call counter. |
| segment fuel | `uint` | The Fuel used in its current Segment. |
| segment alloc | `uint` | The Allocation used in its current Segment. |
| started | `bool` | Whether it has started. |
| waiting | `optional pending` | Its wait, if it is suspended. |
| resume with | `resume` | What it resumes with, if it is ready to resume. |
| suspended at | `name` | Where it suspended, as its Trace shows. |
| waited | `waited` | Its last wait. |
| raised at | `optional position` | Where its current error was raised, if it has one. |
| join | `optional join` | Its Join, if it is in one. |
| clause body | `optional code position` | Its current clause's body, if it has one. |
| fallback | `bool` | Whether it runs a fallback clause. |
| select at | `optional uint` | The instruction its clause selection resumes at, if it is selecting. |
| parked | `bool` | Whether it is parked. |
| abandoned | `list of name` | The call ids it abandoned. |
| base | `uint` | Its Segment's base. |
| segments | `uint` | How many Segments it has started. |
| verdict | `bool` | Whether its Decision verdict is sealed. |
| segment base | `ref` | Its Segment's rollback base, if it has one, in the `runs` section's `bases`. |
| frames | `list of frame` | Its call frames, innermost last. |

#### preemption

Where a Fuel Slice preempted a Run.

| Field | Type | Is |
| --- | --- | --- |
| body | `code position` | The body it was in. |
| fallback | `bool` | Whether it was in a fallback clause. |

#### position

A source position.

| Field | Type | Is |
| --- | --- | --- |
| line | `uint` | Its line. |
| column | `uint` | Its column. |

#### frame

A call frame.

| Field | Type | Is |
| --- | --- | --- |
| body | `code position` | The body it runs. |
| pc | `uint` | Its next instruction, as chapter 8's lowering numbers them. |
| locals | `list of value` | Its locals. |
| stack | `list of slot` | Its operand stack, bottom first. |
| called | `bool` | Whether it was entered by a call. |
| restricted | `bool` | Whether it runs restricted. |

#### limit

A bound on a handler search.

| Field | Type | Is |
| --- | --- | --- |
| frame | `uint` | Its frame. |
| entry | `uint` | Its handler table entry. |

#### search

A handler search in progress.

| Field | Type | Is |
| --- | --- | --- |
| frame | `uint` | The frame being searched. |
| entry | `uint` | The handler table entry being tried. |
| raised | `uint` | The frame the error was raised in. |
| limit | `optional limit` | Where the search stops, if it is bounded. |
| position | `uint` | Its position among recovery offers. |
| skip | `optional limit` | The entries it skips, if any. |

#### cleanup

A cleanup a Run still has to run.

| Field | Type | Is |
| --- | --- | --- |
| frame | `uint` | Its frame. |
| target | `uint` | Its target instruction. |
| depth | `uint` | The operand stack depth it starts at. |
| entry | `uint` | Its handler table entry. |
| leave | `bool` | Whether it leaves the frame after. |

#### failure

A Script error a call failed with.

| Field | Type | Is |
| --- | --- | --- |
| code | `name` | Its error code. |
| message | `optional name` | Its message. |
| data | `optional value` | Its data. |

#### waited

A Run's or Join Member's last wait.

| Field | Type | Is |
| --- | --- | --- |
| id | `name` | Its id. |
| block | `bool` | Whether it was in a timeout block. |
| call | `ref` | Its call, in `calls`. |
| grant | `name` | Its call's Grant. |
| operation | `name` | Its call's Operation. |
| declared | `bool` | Whether the Operation was declared. |
| after | `sint` | Its wait, in microseconds. |

#### pending

A suspended wait: a Suspending Capability call, a `wait`, or a `wait for`.

| Field | Type | Is |
| --- | --- | --- |
| id | `name` | Its id. |
| deadline | `optional sint` | Its deadline, in microseconds since the Unix epoch, if it has one: a suspending call without a `maxPending` or `MaxWait` deadline, or a `wait for` without a timeout or `after` branch, has none. |
| order | `uint` | Its place in the deadline order. |
| call | `ref` | Its call, in `calls`. |
| grant | `name` | Its call's Grant. |
| operation | `name` | Its call's Operation. |
| declared | `bool` | Whether the Operation was declared. |
| after | `sint` | Its wait, in microseconds. |
| member | `ref` | Its Join Member, in the Run's `join`. |
| block | `bool` | Whether it is in a timeout block. |
| branch | `uint` | Its branch. |
| event | `optional event` | Its `wait for`, if it is one. |

#### event

A `wait for` and its branches.

| Field | Type | Is |
| --- | --- | --- |
| unit | `unit` | The unit it is in. |
| entry | `uint` | Its entry. |
| any | `bool` | Whether any branch may fire. |
| branches | `list of branch` | Its branches, in order. |

#### join

A Join in progress.

| Field | Type | Is |
| --- | --- | --- |
| frame | `uint` | The frame that started it. |
| start | `uint` | The instruction it started at. |
| members | `list of member` | Its members, in order. |

#### member

A Join Member.

| Field | Type | Is |
| --- | --- | --- |
| frame | `uint` | Its frame. |
| start | `uint` | The instruction it started at. |
| pending | `optional pending` | Its wait, if it still waits. |
| waited | `waited` | Its last wait. |
| with | `resume` | Its result, if it has one. |
| cut | `bool` | Whether it was cut short. |

#### override

A Delivery's limit overrides.

| Field | Type | Is |
| --- | --- | --- |
| fuel per run | `optional uint` | Its `fuelPerRun`. |
| alloc per run | `optional uint` | Its `allocPerRun`. |
| max wait ms | `optional uint` | Its `maxWaitMs`. |
| max join | `optional uint` | Its `maxJoin`. |

#### delivery

A message on its way to a Script.

| Field | Type | Is |
| --- | --- | --- |
| id | `uint` | Its Delivery id. |
| root | `uint` | The root of its Message Path. |
| message | `name` | Its message name. |
| args | `list of value` | Its arguments. |
| request | `bool` | Whether its sender waits for a reply. |
| during | `optional value` | The value it was sent during, if any. |
| from | `optional name` | The Script that sent it, if a Script did. |
| internal error | `bool` | Whether it reports an internal error. |
| waits | `bool` | Whether its sender is waiting. |
| target | `ref` | Its target, in `objects`. |
| at | `ref` | The object it is at, in `objects`. |
| function | `optional value` | The Function Value it calls, if any. |
| decision | `bool` | Whether it is a Decision. |
| decides | `bool` | Whether its recipient decides. |
| broadcast | `uint` | Its Broadcast id, or 0. |
| limits | `optional override` | Its limit overrides, if any. |
| passed by | `ref` | The object that passed it on, in `objects`. |

#### script work

One Script's queued work.

| Field | Type | Is |
| --- | --- | --- |
| items | `list of work` | In order. |

#### deadline wait

A pending wait, by where it is held.

| Field | Type | Is |
| --- | --- | --- |
| run | `index` | Its Run, in `runs`. |
| member | `ref` | Its Join Member, in that Run's `join`. |

#### mark

A Decision recipient's mark.

| Field | Type | Is |
| --- | --- | --- |
| script | `name` | The recipient Script. |
| run | `name` | The recipient Run. |
| reason | `optional value` | A veto's reason. |
| outcome | `byte` | Its outcome: 0 for `vetoed`, 1 for `errored`, 2 for `limit fault`, 3 for `cancelled`, 4 for `dropped` and 5 for `stopped`. Any other byte is `invalid save`. |

#### open broadcast

A Broadcast Decision some recipient hasn't sealed.

| Field | Type | Is |
| --- | --- | --- |
| id | `uint` | Its Broadcast id. |
| parts | `list of decision part` | One per recipient Delivery. |

#### decision part

One recipient's part in a Decision.

| Field | Type | Is |
| --- | --- | --- |
| delivery | `uint` | Its Delivery id. |
| part | `part` | Its part so far. |

#### deferred decision

A Decision a variables-only restore left for the first Pump.

| Field | Type | Is |
| --- | --- | --- |
| id | `uint` | Its Delivery id. |
| broadcast | `uint` | Its Broadcast id. |
| mark | `optional mark` | Its mark, if it has one. |

#### root discards

One root's discarded messages.

| Field | Type | Is |
| --- | --- | --- |
| root | `uint` | The root. |
| discarded | `uint` | How many messages it discarded. |

#### iterator

An iteration in progress.

| Field | Type | Is |
| --- | --- | --- |
| subject | `optional value` | What it iterates. |
| position | `uint` | Its position. |
| left | `uint` | How many items are left. |

#### reader

A Bytes reader in progress.

| Field | Type | Is |
| --- | --- | --- |
| subject | `value` | The Bytes it reads. |
| position | `uint` | Its position. |

#### replacement

A Text Pattern replacement in progress.

| Field | Type | Is |
| --- | --- | --- |
| text | `value` | The Text it replaces in. |
| matches | `value` | Its matches. |
| spans | `list of span` | The matched spans. |
| next | `uint` | The next match. |
| position | `uint` | Its position in the Text. |
| pieces | `text` | The output so far. |

#### span

A matched span of Text.

| Field | Type | Is |
| --- | --- | --- |
| start | `uint` | Its start. |
| end | `uint` | Its end. |

#### civil date

A date, with or without a time.

| Field | Type | Is |
| --- | --- | --- |
| year | `sint` | Its year. |
| month | `uint` | Its month, 1–12. |
| day | `uint` | Its day, 1–31. |
| time | `optional time` | Its time, if it has one. |

#### time

A time of day.

| Field | Type | Is |
| --- | --- | --- |
| hour | `uint` | Its hour. |
| minute | `uint` | Its minute. |
| second | `uint` | Its second. |
| microsecond | `uint` | Its microsecond. |

#### pair

A Map pair.

| Field | Type | Is |
| --- | --- | --- |
| key | `name` | Its key. |
| value | `value` | Its value. |

<!-- end -->

## Restoring

`Core.Restore(save, options)` builds a new Group from a save. It hasn't been pumped, and it is ready for Host Inputs. Restoring takes these steps, in order, and if any step fails, nothing is made:

1. **Reading:** every Core reads exactly the current [save format](#the-save-format) version, with no automatic snapshot migration. Bytes that aren't a save, a body digest or section digest that doesn't match, an unknown required section, or bytes a section's fields don't account for, are the Host error `invalid save`; so is an older format, including each Core's own formats from before ADR 0144. A save written under nanosecond time resolution is such a format, and its Host starts a fresh Group ([ADR 0091](../docs/adr/0091-time-has-microsecond-resolution.md)).
2. **Libraries:** the Host passes compiled Libraries for the saved identities. The Core matches them by identity, and a Library it needs that isn't given is a mismatch.
3. **Grants:** disabled status is preserved, including with variables-only policy, independently of rebinding. The Host's `Grants` function re-binds each Script's Grants, by the Script's name and the Grant's name. A Grant whose Capability, or kept Operations' declarations, differ from the saved ones is a mismatch, including declarations that differ only in their `labels` ([ADR 0115](../docs/adr/0115-operation-declarations-may-declare-argument-labels.md)). A declaration's `description` and `examples` are never saved or compared ([ADR 0076](../docs/adr/0076-operation-declarations-carry-documentation-that-only-tooling-reads.md)). Only the saved Operation set is retained; additional Operations the Host offers, and their declarations, are ignored. A Grant the Host doesn't return is restored as revoked, so a call through it raises `capability revoked`. It still binds its name, so the Script still loads, in a variables-only restore too. The Core reconstructs all saved source units before applying revocation state, so an existing extension may still call a revoked Grant. It keeps its saved Capability and declarations for step 4, so on its own it never makes a mismatch.
4. **Versions:** the Core computes the Group Fingerprint from the saved Scripts and limits, the Libraries and Grants from steps 2 and 3, and its own language and Cost Model versions. If it equals the saved one, the restore is **full**. Otherwise it is a mismatch, and the Host's `Mismatch` policy decides: `RejectMismatch` fails with the Host error `save mismatch`, `VariablesOnly` does a [variables-only restore](#variables-only-restore), and `ReloadChanged` does a [Partial Restore](#partial-restore) when the only mismatch is Script code, and a variables-only restore otherwise.
5. **Control validation:** before accepting saved dispatch control, validate code identities, body/table/PC references, phase consistency, owner-local layouts and shared storage, pending target argument counts and slots, cleanup references/progress/scope identities, monotonic attempt counters and acyclic ownership/continuations. Malformed state is `invalid save`. Reconstruct aliases only from validated ownership.
6. **Host Objects:** the Host's `Resolve` function turns each saved `(kind, id)` into a native object. An id it can't resolve restores as a disposed Host Object, and its `[kind, id]` is listed in the result's `Disposed`. The Host gets each restored handle back with `group.ObjectByID(kind, id)` ([chapter 9](09-embedding.md#host-objects)).
7. **Text Patterns** are recompiled from their source, charging nothing.
8. **Pending calls** are returned for the Host to settle ([below](#settling-pending-calls)).

`Restore` returns the Group and a result holding whether the restore was variables-only, the Scripts a Partial Restore rebuilt in `Reloaded`, in load order, the pending calls, the Host Objects that didn't resolve, and for a variables-only restore, what it discarded ([below](#variables-only-restore)).

- **The Clock:** the first Pump after a restore must read a Clock at or after the saved reading, or it is the Host error `clock backwards`. A game Host resumes at the saved game time. Waits whose deadlines have passed fire in that Pump, in deadline order, and of equal deadlines, in the order they began ([chapter 5](05-handlers-messages-and-scheduling.md#a-pump)).
- **Fuel Slices:** each Script's debt carries into the first Pump, so a Run preempted before the save resumes exactly where it would have.
- **In the Trace:** a restore is a `restore` record holding the save's Group Fingerprint, whether it was variables-only, the Reloaded Scripts, what it discarded and the disposed Host Objects. Each settlement is a Host Input, recorded when the first Pump drains it.

### Settling pending calls

Each pending call is a suspending Operation call that hadn't been answered when the save was made. The Host settles each one with `Group.Settle(callID, settlement)`, a queued call ([chapter 9](09-embedding.md#threads-and-the-input-queue)), before the first Pump, with exactly one of these:

- **Answer:** the call succeeds with the value, as `Answer` would. Converting it is charged when the Run resumes.
- **Fail:** the call fails with the error, as `Fail` would. A `peer` `call` is always settled this way, with `send failed` and `reason` `unreachable`, since a Remote Send is delivered at most once ([chapter 7](07-libraries-and-the-standard-library.md#peer)).
- **Reissue:** the Operation's `Start` runs again, with the saved arguments and binding, under the same call id. It runs when the first Pump drains the settlement, so `Now` is that Pump's Clock reading. Its declared cost isn't charged again, since it was charged before the save. `Charge` draws Fuel from the Run as it would at the call, counts toward that Pump's Fuel cap and the Script's Fuel Slice and debt, and converting the answer is charged as usual. A later save records the reissued call: its `now` is that Pump's Clock reading, and its `charged` is the Fuel its reissued `Start` charged. A refused `Charge` faults the Run at the saved call, a Join Member at its own call site, as it would at the call, when the Pump drains the settlement: its Segment rolls back, its pending calls are abandoned and none is reissued, and the fault ends a Stretch recorded as `seg … resume`, even for a Run preempted in a Join body.
- **Revocation and reissue:** a saved pending call remains in flight even if its Grant was revoked. If the Host re-binds that Grant, Reissue still starts that same call; revocation continues to block later Script calls. If the Host doesn't re-bind it, Reissue fails the pending call with `capability revoked` without reaching a Host implementation. This absence is determined anew by each Restore, separate from saved revocation state.
- **Adopt:** the Host still has the call in progress, and will answer it under the same call id. It costs nothing. `Settle` returns a new `Call` for it, which the Host answers or fails through. A TS `run` call can't be adopted, since its Promise belonged to the old Group, and adopting one is the Host error `not adoptable`.

- **In order:** the settlements are Host Inputs, queued, and drained by the first Pump in the order they were made, at step 2 ([chapter 5](05-handlers-messages-and-scheduling.md#a-pump)). Then every call still unsettled fails in its Script with `call lost`, in call id order (Script name first, then numeric Run counter, then numeric call counter), before any timer fires. The pending and abandoned call lists use this order too. So an unsettled call is `call lost` even when its deadline has also passed or its Grant was not rebound. As declared in the [error catalogue](data/errors.toml), `call lost` has no code-specific fields: the Core adds the usual source `at`, without `capability` or `operation`.
- **Deadlines:** a settled call's `maxPending` or `MaxWait` deadline, and a Timeout Block's deadline, keep their saved Instants. A reissued or adopted call overdue at the first Pump times out at step 3, unless it has been answered by then.
- **Misuse:** settling a call id that isn't pending, settling one twice, or settling once the first Pump has started, is the Host error `unknown call`. Each is known at the call, so `Settle` returns it, and nothing is queued.

- **Result Targets:** an ordinary pending call resumes before its `store 0` and target stores, so restore assigns its eventual result once without repeating the Host effect. A Join preserves the target of every started member, including repeated executions of one member line, and early answers without writing any target. Restore validates each target's kind and index against its owning frame/code unit; a non-writable or out-of-range destination, missing owner or inconsistent member descriptor is `invalid save`. This retained control is part of [the save format](#the-save-format); older formats are rejected rather than silently losing assignments.
- **Joins:** each member is settled on its own. A Join still waits for all its members, writes its targets in start order only after whole-Join success, and one member's failure fails the Join without writing any member target ([chapter 5](05-handlers-messages-and-scheduling.md#joins)).
- **Fire-and-forget and immediate calls** never pend, so they never need settling.

### Across Scripts

- **Inside the save:** a `send … and wait`, a Function Value call to another Script, or a Decision between Scripts of the saved Group, restores intact, both ends together.
- **Never outside:** Scripts send only within their own Group, and a save covers the whole Group, so every partner is inside it.
- **Deliveries from the Host:** a `Request`, `Call` or `Decide` in flight keeps its delivery id, and its Run reports as usual. Only the future is gone ([What a save leaves out](#what-a-save-leaves-out)).

## Store Notification checkpoints

The Core's save holds no watches ([chapter 10](10-save-and-restore.md#what-a-save-leaves-out)), and the Store's contents stay outside every save. A **checkpoint** is a Group save with the router's state beside it, taken and restored as one unit. A Host that offers `watch` saves and restores Groups through checkpoints.

### Store revisions

Each Store gives a **revision**: opaque text that the Store changes on every commit with changed keys and on nothing else. Two readings are equal only if no commit with changed keys happened between them. A durable Store keeps its revision with its contents. A Store that can't prove continuity, such as an in-memory Store that a new process creates, starts from a revision no earlier reading could have given. So comparing revisions detects every change, including changes made while no router was watching.

### Taking a checkpoint

Between Pumps, the router saves the Group with `Group.Save` and records, under each affected Store's synchronization:

- **Each watch** the Group's Scripts hold: owner, name, the Store's name, prefix, effective message and place in the order of watches.
- **Its pending work:** the pending ordinary Notifications in order, or the pending marker.
- **The Group's retry position,** the watch the next retry round starts at.
- **Each watched Store's revision** at the checkpoint.
- **The SHA-256 of the Group save's bytes,** which ties the routing state to that save.

If `Save` refuses with `effects pending`, the checkpoint is refused the same way and records nothing. A checkpoint records no Store contents.

### Restoring a checkpoint

The router restores a checkpoint by calling `Core.Restore` with the Host's options, then setting up the new Group's routing before it returns, and so before the first Pump. If any step fails, nothing is made and no watch is registered.

1. **Reading:** a checkpoint without routing state, with routing state the router can't read, or whose recorded digest doesn't match its save, is the Host error `invalid checkpoint`. Restoring the save on its own would silently lose its watches, so the router never does that.
2. **The Group:** `Core.Restore` runs as [chapter 10](10-save-and-restore.md#restoring) says, and its errors are returned unchanged.
3. **Variables-only:** a variables-only restore registers no watches, as Reload removes them, and the Host starts its Scripts again as after a Reload.
4. **Full:** each recorded watch is registered again, with its pending work, its place and the retry position, if its Script's named Grant is re-bound to a `store` Grant, through this router, whose binding names the recorded Store. A watch whose Grant is unbound, restored revoked or disabled, or bound to another Store is dropped. A Grant the restore doesn't re-bind is restored revoked ([chapter 10](10-save-and-restore.md#restoring)), so it is dropped as unbound; a Grant revoked or disabled before the checkpoint was released then, so the checkpoint holds none of its watches. The restored Group is a new Group, and takes its place among Groups when its first watch is registered. Nothing reruns Script code, and nothing is redelivered: every admitted Notification is already in the restored Group's mailboxes or input queue.
5. **Source changes:** for each Store whose revision now differs from the recorded one, each restored watch on it becomes resyncing, replacing its pending work with one Reconciliation Marker, and the router attempts to admit those markers immediately, in the order of watches. The marker is a new Host Input, not a replay of the changes it covers.

The result tells the Host which watches were restored, which were dropped and which were resynced.

### Unobservable when nothing changed

A checkpoint restored with the same Store revisions restores the same watches, pending work and retry position, and creates no marker and no Delivery. Given the same later inputs, the restored Group therefore receives exactly the Notifications the original would have, so [ADR 0008](../docs/adr/0008-same-core-save-restore.md)'s rule holds for routing too. A Store that changed between taking and restoring a checkpoint, including in another process or before an offline restore, costs each of its restored watches one marker.

## Variables-only restore

A variables-only restore rebuilds each Script from its saved source and then each of its extensions in the order they were made (or the Host-supplied bundle in native TS external-source mode), against the Core's current versions, the Libraries given and the Grants re-bound, and keeps only its Script Variables. It follows the Reload rule, [carrying variables over](#carrying-variables-over) for every Script at once.

- **Kept:** each Script's Script Variables whose names it still declares, its counters, its owner and well-known objects, its limits, and its revoked and disabled Grants. Host Objects are kept, and resolved as for a full restore.
- **Discarded:** every Run, suspended, parked or preempted, the mailbox, the work queue, the input queue, each Broadcast in progress and the Fuel Slice debt. Runs are discarded with no `finally`. The result lists the discarded Runs in `DiscardedRuns`, the dropped Deliveries (the mailboxes' and the input queue's) in `DroppedMessages`, and the abandoned calls in `AbandonedCalls`, so the Host can cancel the ones it still has. `Pending` is empty.
- **Late answers:** an answer or failure for an abandoned call is recorded and ignored, as for any call that isn't pending ([chapter 9](09-embedding.md#capabilities)). A Host reaches the restored Group with one only over the message layer, since a `Call` from before the save answers into the Group that made it.
- **Reported:** these lists are the report, as a `stop` report's are, so no discarded Run has a `run end`. The one exception is a Decision: the first Pump gives a `decided` report for each open Decision that was discarded or dropped, with each unsealed recipient undecided, `cancelled`, naming its Script and its Run if it had begun. A Broadcast keeps already sealed ballots and aggregates them by the ordinary Verdict rule; a dropped Broadcast not yet given recipients is undecided with empty lists. These deferred reports are saved if the Host saves again before the first Pump ([ADR 0031](../docs/adr/0031-a-decisions-verdict-is-sealed-at-the-end-of-its-first-segment.md)).
- **Function Values** are kept, but they are stale: calling one raises `function gone` ([chapter 3](03-values.md#function-values)).
- **Failing as a whole:** if any Script no longer loads, the restore fails with its `LoadError`. If any Script's carried-over Script Variables would exceed its Persistent State cap, the restore fails with the Host error `state too large`. Either way, nothing is made.
- **Id counters** carry over, so no delivery id, run id or call id is reused, and so does the `random` generator's state, so its draws go on where they were.
- **The Clock** rule still applies, since the last Clock reading is kept.

## Partial Restore

Under `ReloadChanged`, a mismatch only in Script code identity continues the Scripts whose code matches exactly and rebuilds the others ([ADR 0143](../docs/adr/0143-a-restore-may-reload-only-the-scripts-whose-code-changed.md)). Code identity covers a Script's base source, its extensions in order, and the Libraries it imports, so a changed Library changes every Script that imports it, directly or through another Library. A changed Script is one whose identities differ in any of these, including a bundle with fewer or other extensions. Any other mismatch, such as language or Cost Model version, limits, save format or a Grant, makes the whole restore variables-only.

- **Matched Scripts** restore as in a full restore, with their Runs, mailboxes and pending calls.
- **Changed Scripts** are rebuilt from their new code, or the Host-supplied bundle, as a [Reload](#reload) with `CarryVariables` would leave them, carrying variables from the saved prospective post-rollback bindings. Their saved Runs are dropped without decoding their frames, but their Script Variables, mailbox, pending-call records and counters are validated as for a full restore, and malformed state is `invalid save`. Their Runs, dropped Deliveries and pending calls are listed in `DiscardedRuns`, `DroppedMessages` and `AbandonedCalls`, as in a variables-only restore. No Host function runs for them: their Grant releases, Segment participants and scopes were never live in the new Group.
- **Keeping the mailbox:** with `KeepMailbox`, each changed Script is rebuilt as a Reload with `CarryVariables` and `keepMailbox` would leave it ([ADR 0143](../docs/adr/0143-a-restore-may-reload-only-the-scripts-whose-code-changed.md)). Its saved mailbox is restored in order, and its messages, including one a Rewind put back, are dispatched to the new code ([ADR 0068](../docs/adr/0068-a-run-in-its-first-segment-can-be-rewound-to-its-delivery.md)); a message no Handler of the new code takes ends its Run `unhandled` by the ordinary rule ([chapter 5](05-handlers-messages-and-scheduling.md#the-message-path)). None is listed in `DroppedMessages`. Its Runs and pending calls are still discarded and abandoned. The option is one flag for the whole restore, since the Host doesn't know which Scripts changed until it returns. Under `RejectMismatch` or `VariablesOnly`, on a full restore, and when `ReloadChanged` falls back to a variables-only restore, it is ignored, not refused.
- **The cap with a kept mailbox:** a changed Script's kept messages count toward its Persistent State cap with its carried Script Variables, as a live Reload with `keepMailbox` counts them, each at its message's logical size ([chapter 6](06-errors-and-limits.md#limits)). A Script over its cap fails the whole restore with `state too large`.
- **Across Scripts:** a matched Script sees what a Reload of each changed Script would give it. A `send … and wait` or Function Value call waiting on a changed Script, and a Request in its mailbox, fail with `send failed`, reason `stopped`; with `KeepMailbox`, a Request still in the mailbox isn't dropped, so its sender goes on waiting for the new code's reply, and only a call whose Run had begun fails. A Join Member waiting on one fails as that call would, and its Join fails by the ordinary rule. Every Function Value whose Home Script is a changed Script is stale. An open Decision recipient in a changed Script is undecided `cancelled`, reported at the first Pump as in a variables-only restore; with `KeepMailbox`, a recipient whose Run hadn't begun stays open, its Decision or Broadcast still in the mailbox, and only one whose Run had begun is cancelled. A matched Script's active Segment carries on: a discarded Run contributes only its saved base.
- **Reported:** each changed Script has a `stop` report and `run discarded` events with reason `reload`, in `Reports`; with `KeepMailbox`, its `stop` report lists no dropped messages. The `restore` record's Reloaded list stands for these Reloads, so the Trace records no separate Reload Host Input. The record has `mailbox=keep` when the Host asked to keep mailboxes, whether or not the restore was partial, as it has `mismatch=` for the policy asked.
- **Failing as a whole:** if a changed Script no longer loads, or its carried Script Variables, with any kept mailbox, would exceed its Persistent State cap, the restore fails as a variables-only restore does, and nothing is made.

## Reload and extend

A Host changes a loaded Script's code in one of two ways ([ADR 0005](../docs/adr/0005-durability-is-a-deferred-extension.md), [ADR 0014](../docs/adr/0014-a-session-is-an-ordinary-host.md)). Each is a worker call, and a Host Input recorded in the Trace.

- **Kept by both:** the Script's name, its place in the Group's load order, its owner, its well-known objects, its Grants and their revocations, its limits and its counters. `FuelTotal` and the other counters carry on from where they were.

### Reload

`Script.Reload(source, carry)` is stop-and-reload.

1. **Checking:** the new source is loaded against the Script's Grants, Libraries and well-known objects, and its initialiser runs, into new Script Variables. A LoadError leaves the Script unchanged.
2. **Carrying:** with `ResetVariables`, the Script Variables are the new initialiser's values. With `CarryVariables`, they are [carried over](#carrying-variables-over) from the prospective post-rollback bindings: use an active Segment's base for variables it would restore when the old Run stops. Compute and validate this view without yet changing the old Run or calling the Host. A carry that would exceed the Persistent State cap is the Host error `state too large`, and leaves the Script unchanged.
3. **Stopping:** only now, the Script is stopped as Stop Script is ([chapter 6](06-errors-and-limits.md#cancellation-and-stop)), with reason `reload`. Its running, parked and suspended Runs are discarded with no `finally`, the messages in its mailbox are dropped, and their senders get `send failed`, reason `stopped`. Pending calls and live scopes are abandoned, and the current participant is rolled back before replacement. Disabled Grants remain disabled. A fatal lifecycle failure stops the Group and prevents replacement; completed external cleanup is not undone. The Script's [Grant release hooks](09-embedding.md#the-grant-release-hook) remove its watches before replacement and the `stop` report. The `stop` report lists what was discarded.
4. **Replacing:** the new code and Script Variables replace the old, all at once. Every Function Value whose Home Script is this Script becomes stale.

- **Keeping the mailbox:** with `keepMailbox`, step 3 drops none of the mailbox's messages, and their senders go on waiting; the Script's Runs are still discarded. A message a Rewind put back is dispatched to the new code ([ADR 0068](../docs/adr/0068-a-run-in-its-first-segment-can-be-rewound-to-its-delivery.md)).

`Reload` returns the reports for the Runs it discarded. Unlike Stop Script, it isn't sticky: the reloaded Script takes new messages at once.

- **Replacing a Library** stop-and-reloads every Script that imports it, directly or through another Library, as one Reload each, all in one Host Input ([chapter 7](07-libraries-and-the-standard-library.md#registering-identity-and-replacing)). If any of them fails to load, nothing changes.

### Carrying variables over

- **By name:** after the new initialiser runs, each Script Variable that the old code and the new code both declare takes its old value from the prospective post-rollback view. A stopped preempted Run's provisional writes are not carried into new code. A variables-only restore applies the same rule to discarded active Segments. One the new code doesn't declare is dropped, and one only the new code declares keeps its initial value.
- **As they are:** a value is carried as it is, whatever its kind. A carried Function Value whose Home Script is the reloaded Script is stale.
- **The cap:** the Script's Persistent State, measured with the carried values, must fit its cap ([chapter 6](06-errors-and-limits.md#limits)).
- **Migrating:** the language has no migration hook ([#371](https://github.com/odogono/odgn-talk/issues/371)). A Host whose new code changes a variable's shape sends a Handler of the Script's own that converts it, right after a `Reload` without `keepMailbox`, and it is the first message the new code takes.

### Extend Script

`Script.Extend(source)` adds new names to a Script without touching its running code ([#71](https://github.com/odogono/odgn-talk/issues/71)). The source is an Entry: Handlers, functions, Script Variables, Constants and `use` lines.

- **Only new names:** an Entry that declares a name the Script already has, including a Handler of the same name, is the Host error `name reused`, and the Host reloads instead. An Entry can't add Grants or well-known objects, which belong to loading.
- **As a code unit:** the Entry is compiled as a new code unit of the Script, an extension, whose names resolve to the Script's existing ones as well as its own. Its initialiser runs for its new Script Variables and Constants. A LoadError leaves the Script unchanged.
- **The cap:** before the extension applies, the Script Variables it adds and everything the Script already keeps must fit the Persistent State cap. Otherwise the Host error is `state too large`, and the Script is unchanged.
- **Nothing stops:** Runs, watches, the mailbox and pending calls carry on, and Function Values stay valid, since no existing code unit changes.
- **Code identity:** the extension's own code identity is computed as a Script's is, with kind `extension`, the Script's name, and the Libraries its `use` lines import. The extended Script's code identity is then the SHA-256 of the UTF-8 text of three lines, each ended by LF: the previous identity in lowercase hexadecimal, `extend`, and the extension's identity in lowercase hexadecimal ([chapter 9](09-embedding.md#the-pump-and-the-group-fingerprint)). So the Group Fingerprint changes, while Function Values made before stay valid.
- **A Reload** replaces the Script and all its extensions with the one new source.

## Host errors

These are the Host errors this chapter adds to [the catalogue](09-embedding.md#host-error-catalogue): `invalid save`, `save mismatch`, `unknown call`, `state too large`, `effects pending` and `invalid checkpoint`. `reentrant call`, `clock backwards`, `name reused` and `not adoptable` are the ones already there.

## Outside parity

- **Storage:** where the Host keeps a save, and whether it compresses or encrypts it.
- **Futures:** how a Host reconnects its own waiting code to a restored Group's reports.
