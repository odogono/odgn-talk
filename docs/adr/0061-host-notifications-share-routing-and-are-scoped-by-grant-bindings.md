# Host Notifications share routing and are scoped by Grant bindings

Store change notifications ([#227](https://github.com/odogono/odgn-talk/issues/227)) establish a direction for reusable Host notification routing: Host-owned sources produce Notifications, and interested Scripts receive them as ordinary Deliveries. Subscriptions are scoped by the source named in a Grant binding, including when authorized Scripts belong to different Groups. We chose live Notifications with state reconciliation on loading rather than a durable event log; Script-authored publication remains deferred until a concrete use case justifies a general publish/subscribe Capability.

This records the accepted architectural contract agreed during the design interview. The Store remains planned under [ADR 0050](0050-the-store-is-a-standard-capability-with-segment-bound-writes.md) ([#226](https://github.com/odogono/odgn-talk/issues/226)); the Operations below are design, not currently supported behavior. Normative specification and implementation remain pending.

## Considered Options

- **Only Store-specific notification machinery:** sufficient for one source, but other Host-owned sources can reuse subscription routing while retaining their own meaning and permission boundaries.
- **A general Script-facing event bus now:** existing `send`, Broadcast and Host Deliveries already carry messages. Shared Host routing can be introduced without also standardizing Script publication, topic naming and publication permissions.
- **Group-wide Broadcast by message name alone:** membership of a Group and interest in a Selector do not establish access to a particular Store or other granted source. Scripts in different Groups may also share that source.
- **Retaining every Notification for offline replay:** requires history, replay positions and retention policy. For the initial Store use case, Scripts reconcile with current state instead.

## Consequences

### Source boundary and commit semantics

- The Grant binding establishes the source boundary. No ambient global channel namespace is introduced. Routing across Groups remains the Host's responsibility.
- Store Notifications originate from successful Store commits, including Host-originated changes to the shared Store. Writers do not need to explicitly publish a matching message. A failed or rolled-back change produces no corresponding Notification.
- Store writes and their Notifications belong to the Store's own commit mechanism. A separate Segment-bound publication Grant would conflict with [ADR 0048](0048-segment-bound-effects-use-one-host-participant.md)'s single-participant rule; ordinary sends and unrelated effects are not rolled back with Store writes.
- The routing mechanism reuses Deliveries and their existing scheduling, queueing policies and Trace records. It does not introduce another Script execution mechanism.

### Subscription interface

- Scripts express source-specific interest through that source's `watch` and `unwatch` Operations. For the Store, a watch selects a key prefix. A general `events.subscribe` Capability is unnecessary for this first source.
- Watches have Script-chosen names scoped to the Script and named Grant. Watching an existing name with different parameters replaces its registration; repeating an identical registration is a no-op that preserves pending work. Unwatching an unknown name does nothing. Scripts need no opaque subscription token.
- The Store Operations are `watch name, prefix[, message]` and `unwatch name`, both immediate and returning `nothing`. Names are nonempty text. Prefixes match literally as NFC text; the empty prefix watches the whole Store. The default message is `storeChanged`.
- A receiving message must be a valid plain message Name, excluding Reserved Words, `_` and `all`. Colon Selectors are refused because the Notification carries exactly one argument. Validation happens at registration, and an invalid replacement leaves the existing registration unchanged. This is stricter than the embedding API's current acceptance of arbitrary colon-free Delivery names.
- A Notification has one map argument, always with `grant`, `watch`, `prefix`, `keys` and `resync`. The first three are the Script's named Grant, watch name and original watched prefix as text; native Grant binding data is not exposed. An ordinary Notification has `resync: false` and a nonempty list of changed keys in Unicode code-point order, matching `store.keys`. A Reconciliation Marker has `resync: true` and `keys: []`.

Proposed usage and ordinary payload, not yet executable:

```text
ask store to watch "scores", "score/", "scoresChanged"
ask store to unwatch "scores"

{grant: "store", watch: "scores", prefix: "score/",
 keys: ["score/alex"], resync: false}
```

### Notification batching and processing

- A Store Subscription ordinarily receives one Notification per successful commit that changes matching keys, containing each affected key once. It carries keys rather than old/new values: a Handler reconciles with the Store's current state, which may already include later commits.
- Change detection compares a key's committed value before and after the whole commit. Intermediate writes are not exposed, and a key restored to its original value produces no change Notification. This also excludes deleting an already missing key and setting a key to its existing value. A commit with no matching net changes produces no Notification for that Subscription.
- Subscribed Scripts receive their own committed changes as well as other writers' changes. Handlers use the same reconciliation path regardless of writer identity; a Handler that writes back must converge. An unchanged write does not generate a further Notification.
- Store commit order is preserved within each Subscription. Different Groups process Deliveries when their Hosts pump them; there is no simultaneous observation guarantee or order across unrelated Stores.
- Pending notification work is bounded. On exceeding its bound, the router replaces pending detail with a full-reconciliation marker for the watched prefix, delivered when capacity becomes available. This explicitly sacrifices per-commit detail during overload. Notification admission failure never reverses or misreports an already successful Store commit, and a marker must not itself be silently lost to mailbox admission failure.
- While a Reconciliation Marker is pending, later commits remain covered by it rather than accumulating changed-key lists. Admission of that marker and the return to ordinary batching share source synchronization, so changes cannot fall between them. Already admitted Deliveries are not rewritten or withdrawn.
- The Host retries pending marker admission after the recipient Group's Pumps, with fair scheduling across pending watches. Delivery does not depend on another Store write or Script polling. Pumping does not discard a pending marker; checkpointing preserves it. This progress obligation assumes the Host continues pumping and the recipient can eventually accept a Delivery.
- A Handler receiving a Reconciliation Marker refreshes the entire watched prefix against current source state, including removing locally retained keys that no longer exist. Reconciliation is repeatable; the marker does not carry a historical snapshot.
- Routing guarantees admission subject to its bounded reconciliation fallback, not successful Handler execution. There are no acknowledgements or automatic retries after admission. Scripts own Handler failures and queueing choices; `queued` is recommended for changed-key batches. Recurring one-shot waits can miss Notifications between waits.

### Lifetime and registration effects

- A watch belongs to the loaded Script through its named Grant, not to the registering Run. It survives that Run's completion. Stop/unload, successful Reload or revocation of the named Grant removes it; Extend preserves it. Cleanup cannot depend on Script `finally` code or a Run-owned Capability Scope. Existing embedding lifecycle APIs need a contract for this ownership and the effective revocation boundary.
- `watch` and `unwatch` are immediate, final Operations that do not enlist a Segment participant. A later Limit Fault does not undo their effects. Read-only observers can be granted watching without Store write Operations, and watching does not conflict with another Segment-bound Grant.
- Unwatch, replacement and Grant revocation discard Host-pending work under the old registration and prevent further routing through it. Deliveries already admitted to the Core remain immutable and may still arrive; their original prefix retains the old registration's meaning. Existing Stop and successful Reload rules still discard Core messages at their own lifecycle boundaries.

### Reconciliation and checkpointing

- Initial reconciliation registers the watch first, then reads the source's current state. Reads may overlap Notifications, so reconciliation must be repeatable. This closes the registration gap without adding an atomic snapshot Operation; reads across several keys need not describe one atomic Store version. Registration and commit routing must share source synchronization so each commit is unambiguously before or after the registration boundary.
- Notifications missed while a Script is unloaded are not replayed. On loading, a Script reconciles with the source's current state.
- A Host checkpoint preserves registrations and pending routing work alongside the Core's Group snapshot. Full restore reinstates this state before pumping, without rerunning Script registration code or duplicating Deliveries already admitted to the Core. A variables-only restore clears registrations as Reload does. Missing required subscription checkpoint state causes an explicit failure rather than silent loss of watches. The Store's contents remain outside the snapshot.
- [ADR 0008](0008-same-core-save-restore.md)'s unobservable restore remains a constraint: continuous save/restore with the same subsequent inputs must retain the same routing state. Host-held subscription state is not automatically part of a Script Snapshot, so the Host checkpoint contract must coordinate the two; this does not add a generic Core-owned subscription registry.
- After an offline full restore, or restoration of an older checkpoint against a changed source, the Host schedules one Reconciliation Marker per restored active watch. This is a new Host input, not replay of missed changes. A continuous save/restore with unchanged source state adds no marker. Restored routing remains subject to the named Grant's authorization and revocation state.

### Resource bounds

- The Host sets finite limits on registration count and logical size, and pending notification count and logical size. A registration or replacement that exceeds quota raises a catchable error and leaves the previous registration intact. Accepting a registration reserves enough space for its Reconciliation Marker.

### Relationship to earlier decisions

- [ADR 0016](0016-messages-reach-scripts-through-core-owned-object-parents.md) rejected Capability registration that duplicates Handler and pending `wait for` interest. This decision narrows that rejection for source-specific authorization and filtering, which add information that a Selector alone does not carry. Registration selects the source and prefix; existing Handlers and waits continue to process its Deliveries.
- [ADR 0050](0050-the-store-is-a-standard-capability-with-segment-bound-writes.md)'s rejection of Redis-level pub/sub remains in force. This direction develops its deferred post-commit change Notifications; it does not add arbitrary Script publication.

## Specification delivery

[#227](https://github.com/odogono/odgn-talk/issues/227) supplies the follow-up scope, dependent on the planned Store in #226. Subsequent specification work must express this contract as Operation Declarations and Host obligations, declare registration and validation errors, define lifecycle and checkpoint APIs, and supply conformance and Host behavior cases. Neither Core currently provides a subscription registry, effective-revocation cleanup hook or companion checkpoint interface for this feature. The implementation must preserve existing Deliveries, Handler policies, Segment participant semantics and same-core restore invariants; the generalized part is reusable Host routing, not a new Core transport or Script-facing publication Capability.
