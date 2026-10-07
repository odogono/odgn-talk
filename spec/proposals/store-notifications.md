# Store Notifications

**Status: accepted design, specified; implementation pending.** This is the normative specification handoff for [#227](https://github.com/odogono/odgn-talk/issues/227) and [ADR 0061](../../docs/adr/0061-host-notifications-share-routing-and-are-scoped-by-grant-bindings.md). It builds on the Store of [ADR 0050](../../docs/adr/0050-the-store-is-a-standard-capability-with-segment-bound-writes.md) and [ADR 0062](../../docs/adr/0062-a-store-key-is-reserved-while-a-segment-holds-an-uncommitted-write.md), specified in [chapter 7](../07-libraries-and-the-standard-library.md#store). Neither Core, Session Host nor the reference tools offers `watch` or `unwatch` yet. The numbered chapters and executable Data Files remain the active specification.

Language **1.0-rc.2** and provisional **Cost Model 0** stay unchanged: nothing here adds syntax, instructions or costs. On implementation, move these rules into the chapters named in [Acceptance and delivery handoff](#acceptance-and-delivery-handoff), activate the deferred Data File entries, replace the chapters' pending-addition notices, and retire this document. Examples use `text` fences because documentation `talk` fences are checked against the current Operation catalogue. Their results are specified behavior, not execution evidence.

## Purpose and example

A Script that keeps a view of shared Store data asks to hear when that data changes, instead of polling. Each successful commit that changes watched keys sends the Script one ordinary Delivery naming those keys. The Handler then reads current state.

```text
script variable board = {}

on start
  ask scores to watch "board", "score/", "scoresChanged"
  refresh()
end start

on scoresChanged change, queued
  if the resync of change then
    refresh()
  else
    repeat for each key in the keys of change
      ask scores to get key
      put it into board[key]
    end repeat
  end if
end scoresChanged

function refresh
  put {} into board
  ask scores to keys "score/"
  repeat for each key in it
    ask scores to get key
    put it into board[key]
  end repeat
end refresh
```

A commit that sets `score/alex` to a new value delivers `scoresChanged` with one argument:

```text
{grant: "scores", watch: "board", prefix: "score/", keys: ["score/alex"], resync: false}
```

`start` registers before it reads, so no commit falls into a gap between the two. A Notification may describe a key whose value `refresh` already read: reconciliation is repeatable, and the Handler applies the same rule whoever wrote the key.

## Terms

- **Watch:** a Script's registration, made by `watch` through one named Grant. A watch is a [Subscription](../appendix-a-glossary.md). It is identified by its **owner**, the Group, Script and named Grant, and by its **name**, chosen by the Script. Its **parameters** are its prefix and message.
- **Notification:** the Delivery a watch receives. An **ordinary Notification** names changed keys; a **Reconciliation Marker** asks for the watch's whole prefix to be refreshed.
- **Router:** the Host component that holds watches, routes commits to them and admits Notifications into Groups. Its rules are normative for every Host that offers `watch`; [Embedding](#embedding) declares the router each Core supplies.
- **Pending work:** Notifications the router holds for a watch that no Group has admitted yet. A Notification is **admitted** when the recipient Group accepts its Delivery at the call. From then on it belongs to the Core like any other Delivery.

## Operations

### Declarations

These entries join `stdlib.toml` on implementation, after `swap`:

```toml
[[operation]]
capability = "store"
name = "watch"
mode = "immediate"
call = "watch name, prefix [, message]"
gives = "Nothing; from now on, each commit that changes keys beginning with `prefix` delivers `message` to the Script, replacing its watch called `name`"
errors = ["invalid watch", "watch limit"]

[[operation]]
capability = "store"
name = "unwatch"
mode = "immediate"
call = "unwatch name"
gives = "Nothing; removes the Script's watch called `name` through this Grant, if there is one"
errors = ["invalid watch"]
```

- **Shapes:** `watch` takes text, text and an Optional text, and `unwatch` one text. Both give `nothing`, and the Core checks the result kind; anything else becomes `host error`.
- **Mode:** both are immediate and neither is Segment-bound. They never enlist a participant, so they don't conflict with another Store's writes in the same Segment. A Grant of only `get`, `keys`, `watch` and `unwatch` lets a Script observe a Store without being able to write to it.
- **Final at the call:** a registration takes effect when the Host function returns. A later Limit Fault, rollback, `effect failed` or cancellation of the calling Run doesn't undo it.
- **Arity:** `watch` takes two or three supplied arguments, and `unwatch` exactly one. Omitting or passing Nothing as `message` means `storeChanged`. The Trace and the Host function's supplied arguments keep the call as the Script wrote it. The `store` factory gives the implementation the effective message, as `calendar` resolves its default zone.

### Validation

After the Shape checks and before charging the call or running the Host function, the Core checks these, in order. A failure raises `invalid watch`, with `field` set to `name` or `message`. No call id is allocated and the Host isn't called, so an invalid replacement leaves an existing watch unchanged.

1. **`name`,** for both Operations, is nonempty text.
2. **The effective message,** for `watch`, is a plain Name ([chapter 1](../01-lexical-structure.md#tokens)): not a Reserved Word, `_` or `all`, and not a Selector. A Notification carries exactly one argument, so a name containing `:` is refused even when it would be a one-part Selector.

The prefix is any text, including empty text, which watches the whole Store. Values are NFC, so a prefix is compared as the `keys` Operation compares it, by code points.

These checks are the Core's. Every other failure is the Host's: `watch limit` ([Limits](#limits)) and, as for any declared Operation, `host error` for anything undeclared. `capability revoked` and `capability disabled` come before every one of these, as for any Operation.

### New error codes

These entries join `errors.toml` on implementation, with sources `ADR 0061` and `#227`:

| Code | Fields | Raised when | Message |
| --- | --- | --- | --- |
| `invalid watch` | `field` | A `store` `watch` or `unwatch` is given empty text as its name, or `watch` an effective message that isn't a plain Name; `field` is `name` or `message`, and the Core raises it before the Host function runs | A watch's {field} isn't valid |
| `watch limit` | `limit` | A `watch` would take its Store's watches past a limit, after removing the watch it replaces; `limit` is `watches`, `size` or `pending`, and the Host raises it before anything changes | The Store's {limit} limit for watches would be exceeded |

## Registrations

- **Identity:** a watch belongs to its owner and name. Two named Grants bound to the same Store hold separate watches, even with the same name, and each Notification names the Grant it came through.
- **`watch`, new name:** registers the watch with no pending work.
- **`watch`, same parameters:** a watch whose prefix and effective message both equal the existing one's does nothing, and keeps the watch's pending work and its place in the order of watches.
- **`watch`, different parameters:** replaces the watch. The router discards the old watch's pending work, routes nothing more under the old parameters, and keeps the watch's place in the order of watches. Notifications already admitted keep the old prefix in their payload, which still describes them.
- **`unwatch`:** removes the watch and discards its pending work. Unwatching a name the owner hasn't registered does nothing.
- **The registration boundary:** registration and commit routing share the Store's synchronization ([Routing](#routing)), so each commit is either before a registration, and never routed to it, or after, and routed. A Segment's uncommitted writes commit after a `watch` made in that same Segment, so they are routed to the watch.
- **Initial reconciliation:** a Script registers first and then reads the Store. Its reads may already include a commit that a Notification will also report, and several reads need not observe one Store version. No snapshot Operation is offered.

## Routing

### Commits and synchronization

A **commit** is any change to a Store's committed contents: a Segment commit hook that returns `ok`, and every Host-originated change, such as a Session's `:store load` or `:store clear`, an import or an administrative write. A commit that fails, a rollback, and a Segment's uncommitted writes produce nothing.

The Store applies a commit and the router routes it as one step under the Store's **synchronization**: a per-Store mutual exclusion that `watch`, `unwatch`, every commit, marker admission and checkpointing also take. A Host that runs several Groups on several threads, or reaches one Store from several processes, must provide it. Store commit order is the order commits take it.

### Net changes

- **Changed keys:** a key changes when its committed value after the commit differs from its value before, compared by the bytes of [the Value Encoding](../09-embedding.md#json-and-the-value-encoding). A missing key and a key holding Nothing are one state.
- **Whole commits only:** intermediate writes inside one commit aren't seen. A key set and then restored, a delete of a missing key and a `set` of the value already there change nothing.
- **No change, no work:** a commit with no changed keys routes nothing and doesn't change the Store's [revision](#store-revisions).

### Which watches

For a commit with changed keys, each watch on that Store whose prefix is a code-point prefix of at least one changed key receives one ordinary Notification, holding each such key once. Every watch matches, including those of the Script whose Segment committed.

The router visits matching watches in its **order of watches**: by Group, in the order the router first registered a watch from that Group, then by Script, in the Group's load order, then by named Grant and watch name, each in Unicode code-point order. A replaced watch keeps its place; one removed and registered again goes to its new place.

### Payload

A Notification is a Delivery addressed to the owning Script with `Script.Deliver`. It has the watch's effective message as its name, exactly one argument and no limit override. The argument is a map with these keys, in this order:

| Key | Value |
| --- | --- |
| `grant` | the named Grant the watch was made through, as text |
| `watch` | the watch's name |
| `prefix` | the watch's prefix |
| `keys` | an ordinary Notification's changed keys under the prefix, nonempty and in Unicode code-point order, as `store.keys` orders them; `[]` for a Reconciliation Marker |
| `resync` | `false` for an ordinary Notification, `true` for a Reconciliation Marker |

The payload never holds values, old or new, or the Grant's binding. Each Notification is recorded in the Trace as the ordinary `deliver` Host Input it is.

### Admission and pending work

A watch is in one of two states: **ordinary**, with zero or more pending ordinary Notifications in commit order, or **resyncing**, with exactly one pending Reconciliation Marker.

1. **Routing a commit to an ordinary watch with no pending work:** the router delivers the Notification at once. If the Group accepts it, it is admitted. If the Group refuses it as `MailboxFull`, the Notification becomes the watch's pending work, subject to step 3.
2. **Routing a commit to an ordinary watch with pending work:** the Notification joins the end of its pending work, subject to step 3, so a later commit is never admitted before an earlier one.
3. **Overload:** if holding the Notification would take the Store's pending work past the `pending` or `pendingSize` limit, the router discards the watch's pending ordinary Notifications and makes the watch resyncing instead. This sacrifices per-commit detail. It never fails, delays or reports the commit itself.
4. **Routing a commit to a resyncing watch** adds nothing: its pending marker already covers the commit.
5. **Any other refusal:** if a Delivery is refused for any reason other than `MailboxFull`, such as the Script no longer being in the Group, the router removes the watch and discards its pending work.

Admission is never undone. A Notification already admitted is never rewritten, withdrawn or replaced by a marker, and stays subject to the Core's own rules, such as Stop and Reload dropping a mailbox.

### Retrying

- **When:** after each Pump of a Group returns, the Host calls the router, and the router attempts to admit pending work for that Group's watches. Retrying needs no further Store write and no polling by a Script, and the Pump never discards pending work.
- **Fair order:** a retry round visits the Group's watches with pending work in the order of watches, starting with the watch after the one that started the Group's previous round and wrapping around. For each watch it delivers pending Notifications oldest first, stopping at that watch's first refusal and moving on to the next watch.
- **A marker's return:** admitting a Reconciliation Marker makes its watch ordinary again, under the Store's synchronization, so each commit is either covered by the marker or routed as an ordinary Notification after it.
- **Progress:** pending work is admitted provided the Host goes on pumping the Group and the recipient eventually accepts a Delivery. The router tells the Host when a Group still has pending work, so a driver can schedule another Pump.

### What a Script can rely on

- **Order:** within one watch, Notifications are admitted in Store commit order, and a marker is admitted after everything it replaced would have been. Nothing is promised between different watches, Stores or Groups, or about when a Group pumps.
- **Admission, not handling:** the router guarantees admission, falling back to one marker under overload. It doesn't promise that a Handler runs or succeeds. There are no acknowledgements and no retries after admission. A Notification that reaches the end of the Message Path is `unhandled`, and an errored Handler is the Script's to deal with.
- **Handlers:** `, queued` is recommended for a Handler of ordinary Notifications, so batches aren't dropped or replaced. A `wait for` that waits for one Notification and then waits again can miss the ones in between.
- **Reacting to a marker:** a Handler refreshes the watch's entire prefix from current state, including removing keys it holds that no longer exist.
- **Writing back:** a Handler that writes to a key it watches receives a Notification for its own write. It converges because a write that changes nothing routes nothing.

## Lifetime

A watch belongs to its owner, the loaded Script and named Grant, not to the Run that registered it. It outlives that Run, and cleanup never depends on a Script `finally` block or a Capability Scope.

### The Grant release hook

A Capability may supply a **release hook**. The Core calls it synchronously when one Script's named Grant stops being effective, and the Host drops everything it holds for that owner. The `store` factory passes the implementation's release hook, which forwards to the router.

The hook receives the Group's identity, the Script's name, the named Grant, its binding, the Group's last Clock reading and a **reason**:

| Reason | When the Core calls it |
| --- | --- |
| `stop` | the Script is stopped: a Host Stop as it lands, disposal of its owner, or every Script when fatal effect uncertainty stops the Group |
| `reload` | a Reload of the Script, or a Library replacement that reloads it, succeeds |
| `revoke` | a `revoke` Host Input for that named Grant is drained, the first time only |
| `disable` | failed automatic abandonment disables that named Grant |

- **Which Grants:** for `stop` and `reload`, the Core calls the hook for every named Grant the Script keeps whose Capability supplies one, in Unicode code-point order of the names. Grants already released by `revoke` or `disable` are included, since the hook is idempotent for the Host.
- **When, relative to other cleanup:** for `stop` and `reload`, after abandoning the Script's scopes and rolling back its participant, and before the `stop` report, the replacement code or any later execution. For `disable`, right after the `effect failure` report for the failed abandonment. For `revoke`, when the input is drained, before anything later in that Pump.
- **Not released:** a rejected Reload or Library replacement, an Extend, a repeated revocation, a revocation of a name the Script doesn't keep, or Save. A Restore never calls the hook: the new Group's routing is set up by [checkpoint restore](#checkpoints).
- **Its contract:** like the Segment lifecycle hooks, it is Host work with no Script result, cost or Trace record. It runs inside a Pump, or within `Reload` or `ReplaceLibrary` outside one. It may queue inputs but can't make worker calls, which are `reentrant call`. It returns nothing, and the Core ignores anything it throws or panics with, because releasing can't be refused. Its timing follows records the Trace already has, so a replay calls it at the same points.
- **On the message layer:** the Core sends `release` as an interim reply to `pump`, `reload` or `replace-library`, with `script`, `grant`, `reason` and `now`, and the Host answers `release-result` with no fields.

### What release does

On release, the router removes every watch the owner holds and discards their pending work, and no later commit routes through them. Only a new `watch` registers again, which a revoked or disabled Grant refuses. Notifications already admitted aren't touched. Stop and a successful Reload drop the Script's mailbox under their own rules, and after a revocation or disablement any that remain are delivered and handled as usual.

After a Reload, a Script has no watches. A Host that reloads Scripts sends the message its Scripts use to start up, such as `start` above, so they register again and reconcile. Extend keeps every watch, since no code is replaced and no Grant is released.

### Groups the Host discards

When a Host stops using a Group, it tells the router to detach it, and the router removes every watch the Group's Scripts hold. A Group that is only saved and later restored is a different Group, with routing of its own ([Checkpoints](#checkpoints)).

## Checkpoints

The Core's save holds no watches ([chapter 10](../10-save-and-restore.md#what-a-save-leaves-out)), and the Store's contents stay outside every save. A **checkpoint** is a Group save with the router's state beside it, taken and restored as one unit. A Host that offers `watch` saves and restores Groups through checkpoints.

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
2. **The Group:** `Core.Restore` runs as [chapter 10](../10-save-and-restore.md#restoring) says, and its errors are returned unchanged.
3. **Variables-only:** a variables-only restore registers no watches, as Reload removes them, and the Host starts its Scripts again as after a Reload.
4. **Full:** each recorded watch is registered again, with its pending work, its place and the retry position, if its Script's named Grant is re-bound to a `store` Grant, through this router, whose binding names the recorded Store. A watch whose Grant is unbound, restored revoked or disabled, or bound to another Store is dropped. Nothing reruns Script code, and nothing is redelivered: every admitted Notification is already in the restored Group's mailboxes or input queue.
5. **Source changes:** for each Store whose revision now differs from the recorded one, each restored watch on it becomes resyncing, replacing its pending work with one Reconciliation Marker, and the router attempts to admit those markers immediately, in the order of watches. The marker is a new Host Input, not a replay of the changes it covers.

The result tells the Host which watches were restored, which were dropped and which were resynced.

### Unobservable when nothing changed

A checkpoint restored with the same Store revisions restores the same watches, pending work and retry position, and creates no marker and no Delivery. Given the same later inputs, the restored Group therefore receives exactly the Notifications the original would have, so [ADR 0008](../../docs/adr/0008-same-core-save-restore.md)'s rule holds for routing too. A Store that changed between taking and restoring a checkpoint, including in another process or before an offline restore, costs each of its restored watches one marker.

## Limits

Each Store's router state has four finite limits, which its Host sets:

| Limit | Counts | Exceeded |
| --- | --- | --- |
| `watches` | the Store's watches, across every Script and Group | `watch limit` `{limit: "watches"}` at `watch` |
| `watchSize` | the total size of the Store's watches: for each, the [logical sizes](../08-the-abstract-machine-and-the-cost-model.md#logical-sizes) of its name, prefix and effective message as text | `watch limit` `{limit: "size"}` at `watch` |
| `pending` | the Store's pending Notifications, with one reserved for every watch | `watch limit` `{limit: "pending"}` at `watch`; overload when routing |
| `pendingSize` | the total logical size of their payload maps, with every watch's marker reserved | `watch limit` `{limit: "pending"}` at `watch`; overload when routing |

- **The reservation:** every watch always counts one Reconciliation Marker toward `pending` and `pendingSize`, whether or not it has pending work. A resyncing watch's marker occupies that reservation, so a marker always fits and is never lost to a limit.
- **Registering:** a `watch` checks all four limits with its own watch, and its reservation, in place of any it replaces. If a limit would be exceeded, the Host fails the call with `watch limit`, naming the first limit in the table's order, and the existing watch and its pending work are unchanged. Same-parameter `watch` and `unwatch` never fail on a limit.
- **Pending ordinary Notifications** count in addition to the reservations, and overload is decided against both pending limits.
- **Restoring** a checkpoint registers restored watches without checking these limits, so a restore never drops a watch for space. Later registrations are checked against the restored totals.

## Embedding

### Declarations

On implementation, `talk.ts` and `talk.go` gain the release hook, the `store` additions and the router helper. Idiom follows chapter 9. The TS form is:

```ts
export type ReleaseReason = "stop" | "reload" | "revoke" | "disable";
export interface GrantContext<B> {
  readonly group: Group;
  readonly scriptName: string;
  readonly grantName: string;
  readonly binding: B;
  readonly now: bigint;
  readonly reason: ReleaseReason;
}
/** Synchronous, unmetered and infallible; called once the named Grant stops being effective. */
export type ReleaseHook<B> = (context: GrantContext<B>) => void;

export interface Core {
  // An optional fourth argument; Segment lifecycle and release are independent.
  defineCapability<B = void>(name: string, ops: Record<string, Operation<B>>,
    lifecycle?: SegmentLifecycle<B>, release?: ReleaseHook<B>): CapabilityDef<B>;
}

export interface StoreImpl extends SegmentLifecycle<string> {
  // ...the six existing Operations...
  /** message is the effective message. Throw ScriptError `watch limit` {limit}. */
  watch(call: Call<string>, name: string, prefix: string, message: string): void;
  unwatch(call: Call<string>, name: string): void;
  release(context: GrantContext<string>): void;
}
```

In Go, `DefineCapability` and `DefineSegmentCapability` take an option carrying a `func(GrantContext)` release hook, and `StoreImpl` gains `Watch(c *Call, name, prefix, message string) error`, `Unwatch(c *Call, name string) error` and `Release(GrantContext)`. The `store` factory requires all eight Operations, the three Segment lifecycle hooks and `release`; a missing one is `invalid value`. The Host Manifest and Group Fingerprint cover the two new Operation Declarations as usual, and exclude the hook.

### The router

Each Core supplies a router as a helper built only on this interface, at `@odgn/northtalk/notify` in TS and `github.com/odogono/odgn-talk/impl/go/notify` in Go. As with the drivers, its idiom is outside parity, but every rule in this document applies to it. A Host with its own storage builds a `StoreImpl` around it:

```ts
export interface WatchLimits { watches: number; watchSize: number; pending: number; pendingSize: number }
export interface RouterOptions {
  limits(store: string): WatchLimits;
  /** The Store's current revision; read under its synchronization. */
  revision(store: string): string;
}
export interface RoutingResult { restored: string[]; dropped: string[]; resynced: string[] } // "<script>.<grant>.<watch>"
export interface NotificationRouter {
  watch(call: Call<string>, name: string, prefix: string, message: string): void;
  unwatch(call: Call<string>, name: string): void;
  release(context: GrantContext<string>): void;
  /** Applies a commit under the Store's synchronization; apply returns its changed keys. */
  commit(store: string, apply: () => readonly string[]): void;
  /** After each Pump of the Group returns. True while the Group still has pending work. */
  pumped(group: Group): boolean;
  detach(group: Group): void;
  save(group: Group): Uint8Array; // a checkpoint; throws effects pending as Group.save does
  restore(core: Core, checkpoint: Uint8Array, o: RestoreOptions):
    { group: Group; result: RestoreResult; routing: RoutingResult };
}
export declare function createRouter(o: RouterOptions): NotificationRouter;
```

The router owns each Store's synchronization, so a Store applies every commit, including Host-originated ones, through `commit`. Revisions, checkpoint bytes and the router's internal layout are each implementation's own, and a checkpoint restores only through the router family that took it, as a save restores only on its own Core family.

### Host errors

`invalid checkpoint` joins `host-errors.toml`: "A checkpoint's routing state is missing, unreadable or doesn't match its Group save." `effects pending`, `invalid save`, `save mismatch` and the other restore errors keep their meanings.

### Other sources

A later Host-owned source reuses the router's ownership, release, admission, ordering, overload, retry, limits and checkpoint rules. It defines its own `watch` parameters, matching rule, payload fields and revision. Script-authored publication stays deferred ([ADR 0061](../../docs/adr/0061-host-notifications-share-routing-and-are-scoped-by-grant-bindings.md)).

## The Session Host

On implementation, [chapter 12](../12-sessions-and-tooling.md#the-session-store) gains these rules:

- **Grants:** `:grant <name> store [<store>]` grants all eight Operations, including `watch` and `unwatch`.
- **Costs:** `watch` costs 4 Fuel and `unwatch` 2, with no declared allocation.
- **Limits:** for each Session Store, `watches` 100, `watchSize` 65,536, `pending` 1,000 and `pendingSize` 1,048,576.
- **Revisions:** a Session Store's revision counts its commits with changed keys from 0, within the Session Host's memory.
- **Pumping:** after a Pump that leaves Host Inputs queued, such as Notifications, the Session Host pumps again at the same Clock reading, and keeps doing so until a Pump leaves none. A Notification's Run is a background Run, so its output lines start with `[<run>] `. A Handler whose own write always changes a key it watches never lets the session settle, as a Handler that keeps sending to itself doesn't.
- **Host changes:** `:store load` and `:store clear` are commits, routed by their net changes, and the Session Host pumps after one that queues a Notification. Each still runs between Pumps and isn't itself a Host Input.
- **Reload:** redefining a declaration reloads the Session Script, which removes its watches. An Entry can register them again. Extending, by declaring new names, keeps them.
- **`:save` and `:restore`** keep a checkpoint, not a bare save, with the Session Host's own state. `:restore` restores it through the router, so a Session Store that changed since `:save` sends one marker to each restored watch on it.

The run ids in this Transcript are illustrative:

```text
> :grant scores store
> on scoresChanged change, queued
|   say the keys of change
| end scoresChanged
> ask scores to watch "all", "", "scoresChanged"
> ask scores to set "alex", 3
[session/r3] ["alex"]
> ask scores to set "alex", 3
> :save
saved default
> :store clear
[session/r5] ["alex"]
> :restore
restored default
[session/r5] []
```

The second `set` changes nothing, so it sends nothing. `:store clear` removes `alex`. The restore brings back the run id counter of the save, and the watch, which is resynced because the Store's revision changed after `:save`. Its marker's `keys` is `[]`.

## Conformance

### Core scenarios

Implement these as Trace Cases under `corpus/capabilities/` with `store` Stubs, and as embedding tests for the release hook and the message layer. Both Cores must pass each, with and without injected save/restore.

| Scenario | Required observation |
| --- | --- |
| `watch` with two and three arguments, Nothing as `message`, `unwatch` | Supplied arguments are kept in the `call` record; the Host receives the effective message; both give Nothing |
| Empty name; message `""`, `"all"`, `"_"`, `"put"`, `"move:"`, `"to:at:"`, `"9lives"` | `invalid watch` with the right `field`, name checked first; no call id, no Host call, no charge |
| Wrong Shapes and argument counts | `wrong kind` at run time, `wrong argument count` at load |
| `watch` beside another Store's writes in one Segment | No participant enlisted; no `segment participant conflict` |
| `watch` then Limit Fault, rollback or `effect failed` | The call stays in the Trace as made; nothing about it rolls back |
| Revoked and disabled Grants | `capability revoked` or `capability disabled` before validation, `disabled` first |
| `GrantsAsUsed` | `watch` and `unwatch` are kept only when used |
| Host failures | `watch limit` raises with `{limit}`; an undeclared code becomes `host error` |
| Release on Stop, owner disposal and fatal effect uncertainty | `stop` for every kept Grant with a hook, in name order, after abandonment and rollback, before the `stop` report |
| Release on Reload and Library replacement | `reload` only on success, before the replacement runs; none on rejection |
| Release on revocation | `revoke` once when drained; none for a repeat or an unknown name |
| Release on disablement | `disable` right after the abandonment's `effect failure` report |
| No release | Extend, Save, Restore and rejected Reloads call no hook |
| Hook misuse | A worker call from the hook is `reentrant call`; a throw or panic is ignored |
| Message layer | `release` interim requests carry the initiating `ref`; final replies wait for `release-result` |
| Fingerprint and manifest | The `store` Grant's declarations include `watch` and `unwatch`; the hook doesn't affect identity |

### Router kit

Add `corpus/notify-kit/` beside [the store kit](../../corpus/store-kit/README.md): language-neutral TOML sequences that drive a router, its Store and stand-in Groups, and that the corpus runners skip. Each sequence sets limits and runs steps that register, unregister, commit with given changed keys, set a Group's mailbox to accept or refuse, report a Pump, release, detach, take a checkpoint, change a revision and restore. Each step states the Deliveries it makes, each with its Group, Script, message and payload, and any error. Both Cores' routers run the whole kit. It covers:

| Scenario | Required observation |
| --- | --- |
| Net change | Set to the same value, delete of a missing key, set-then-restore in one commit and a no-op increment route nothing; a changed value routes once, with sorted unique keys |
| Matching | Empty prefix, a prefix equal to a key, a non-matching prefix and NFC prefixes; a commit spanning two watches routes one Notification to each |
| Own writes | The writing Script's own watch receives its commit |
| Order of watches | Across Groups, Scripts, Grant aliases and watch names; replacement keeps the place, unwatch and re-watch moves it |
| Replacement | Identical parameters keep pending work; different parameters discard it and route only under the new ones; an invalid or over-limit replacement leaves the old watch as it was |
| Registration boundary | A commit before `watch` isn't routed; a commit after is; a Segment's own pending write after its `watch` is |
| Mailbox refusal | A refused Notification is held; later commits queue behind it; retry after the Pump admits them in order |
| Overload | Exceeding `pending` or `pendingSize` turns one watch resyncing, discarding only its own pending detail; already admitted Deliveries stay |
| Resyncing | Later commits add nothing; marker admission returns the watch to ordinary; the next commit routes an ordinary Notification |
| Fair retry | Rounds rotate their starting watch; one watch's refusal doesn't stop another's admission |
| Other refusals | A refusal other than `MailboxFull` removes the watch |
| Limits | Each of the four limits refuses `watch` with its `limit` word, in table order; the marker reservation counts from registration |
| Release and detach | Each reason removes the owner's watches and pending work; admitted Deliveries stay; detach removes a Group's watches |
| Checkpoint, unchanged source | Restore reinstates watches, pending work and retry position with no Delivery |
| Checkpoint, changed source | One marker per restored watch on each changed Store, admitted at once in the order of watches |
| Checkpoint, Grants | Unbound, revoked, disabled and re-bound-to-another-Store watches are dropped and listed |
| Checkpoint, variables-only | No watches restored |
| Checkpoint, damaged | Missing routing state and a mismatched digest are `invalid checkpoint`, and nothing is made |
| Checkpoint refused | `effects pending` refuses the checkpoint |

### Session Transcripts

Add Transcripts under `corpus/sessions/` for an ordinary Notification, a Handler of the writer's own change, an unchanged write, `unwatch`, removal by redefinition, `:store load` and `:store clear` routing, and `:save` and `:restore` with and without a Store change since the save.

## Acceptance and delivery handoff

The implementation must include both Cores, both routers, both Session Hosts and the reference tools before these rules are moved into the chapters and the Data Files are activated. Generated declarations alone don't implement behavior.

- **Deferred Data File entries:** `stdlib.toml` (`watch` and `unwatch`), `errors.toml` (`invalid watch` and `watch limit`), `host-errors.toml` (`invalid checkpoint`) and their generated consumers. `session.toml` changes only in its `:grant` and `:store` wording. `corpus.toml` and `trace.ebnf` need no change: Notifications are ordinary `deliver` inputs.
- **Embedding files:** `spec/embedding/talk.ts` and `talk.go` gain the declarations in [Embedding](#embedding), and the message-layer table gains `release`.
- **Chapters to integrate:** chapter 7's `store` section (Operations, validation, routing, payload, limits), chapter 6's error table, chapter 9's Capabilities, release hook, message layer and Host error catalogue, chapter 10's save rules and checkpoints, chapter 11's scenario tables and chapter 12's Session Store.
- **Tooling:** the reference checker, LSP and Playground learn the two Operations from the regenerated catalogue. No new Advanced tag is needed.
- **First blessing:** every new Trace Case, kit sequence and Transcript expectation is written or derived independently and reviewed by a person before blessing. Execution agreement between the Cores isn't approval. Present the expectation diffs, including changed Fingerprints of existing `store` cases, for review.
