# The Store is a Standard Capability with Segment-bound writes

A Script that keeps a high score or a setting beyond one load needs somewhere outside its Script Variables, and ADR 0005 leaves durable records to Host Capabilities. `store` becomes a sixth Standard Capability: a Host-kept Store of data values under text keys, named by the Grant binding so Scripts granted the same binding share it. Its Operations are all immediate, and its writes are Segment-bound (ADR 0048), so a Store change commits or rolls back with the Script Variables of the Segment that made it. We chose this so the Store behaves like Script Variables that outlive a reload, which is what a beginner expects, and so every Host offers the same shape for the Conformance Corpus and for portable Scripts. Until the Spec holds the rules, the Consequences below record them.

## Considered Options

- **A Host-defined convention instead of a Standard Capability:** saving progress is ordinary work, and Scripts should run unchanged in the Playground, the Bun Host and the Go Host.
- **Suspending Operations:** a natural fit for Redis or IndexedDB, but every read becomes a Suspension Point, Runs interleave between a read and its write, and Segment-bound effects and Capability Scopes need immediate Operations. A Host backed by remote storage answers from a working set it holds, which the quotas bound.
- **Writes final at the call, like localStorage:** a Limit Fault would roll back Script Variables while the Store keeps the write.
- **The Core buffering writes until the Segment commits:** it puts Store logic in the Core, which ADR 0005 keeps out for `timer`, and spends no participant only by special-casing one Capability.
- **`tell store to set`:** Segment-bound Operations must be immediate, and `tell` is only for fire-and-forget. Making fire-and-forget Segment-bound would move `store full` to commit time, where it ends the Run as `effect failed` and can't be caught.
- **Optimistic conflict detection on shared keys:** a conflict would end the Run as `effect failed`, with no catch and no retry. Lost updates from a plain `get` then `set` are accepted instead, and `increment` and `swap` are the atomic tools.
- **Text-only values:** every Script would need `json`. Data values are stored by the Value Encoding.
- **Any value as a key:** a Host mapping keys onto its backend would need an encoding of values into key text that both Cores match bit for bit.
- **Expiry (TTL):** it raises which clock decides, whether expired keys count toward quotas and how they replay, for a cache feature the Store isn't for. `clock` and `timer` cover it in Scripts.
- **Redis-level features (structured partial updates, pub/sub):** a Redis-sized surface every Host must implement. Value Semantics makes the whole value the unit, and `send`, Broadcast and Host Deliveries already carry messages. A Host may offer them in its own Capability.
- **The Store in Script Snapshots:** the Host owns the Store, and outliving the Script's own state is its purpose.

## Consequences

- **Operations**, all immediate:
  - `get key[, default]` gives the value, or `default`, or `nothing`. Reads see the Segment's own uncommitted writes.
  - `set key, value` gives `nothing`. Setting `nothing` deletes the key, so a missing key and one holding `nothing` are one state. Segment-bound.
  - `delete key` gives `nothing`, and deleting a missing key does nothing. Segment-bound.
  - `keys [prefix]` gives a list of text in Unicode code-point order.
  - `increment key[, by]` gives the new value. `by` defaults to 1, a missing key counts as 0, and the ordinary `+` rules apply, so Quantities work and other kinds raise `wrong kind`. Segment-bound. It gives the value as seen at the call, and commit applies the delta, so concurrent increments never lose counts.
  - `swap key, expected, new` gives `true` or `false`, comparing by value equality. `expected` of `nothing` means "only if missing", and `new` of `nothing` deletes. Segment-bound.
- **Errors:** `store full` with `{limit}` (`size`, `keys` or `value`), `can't store` with `{kind}` for Function Values and Host Objects, and `invalid key` for empty text.
- **Keys** are text, compared exactly as NFC text (ADR 0011).
- **Quotas:** the Host sets a Store's total size, key count and largest value, counted by logical size. Store contents don't count toward Persistent State. A `get` charges the returned value to the Run's Allocation Budget, and each Operation's Fuel comes from the Grant's cost map.
- **Sharing:** the Grant binding names the Store, never the Script text. A Grant of only `get` and `keys` is read-only and never enlists a participant. Last write wins between plain writes.
- **Participants:** writing to two writable Stores, or to a Store and another Segment-bound Grant, in one Segment raises `segment participant conflict`. This is the first ordinary case where ADR 0048's single participant bites.
- **Conformance:** the Spec states Store semantics as Host obligations, as for `timer`. Trace Cases cover the Core's side through Stubs and lifecycle Stubs, and a shared Host test kit holds the Example Hosts' and the Session Host's Stores to the semantics.
- **Snapshots** never include the Store, so restoring an older snapshot can leave Script Variables and the Store disagreeing. Resetting Play State (ADR 0041) leaves the Store alone.
- **Sessions:** the Session Host's Store is in memory and starts empty, with `:store` Session Commands to load, save and clear it.
- **Tooling:** a `store-race` Lint in the `standard` Profile flags a `get`, a value computed from it and a `set` of the same key in one Handler, and points to `increment` or `swap`.
- **Follow-up design:** change notifications as Host Deliveries after commit are developed in [ADR 0061](0061-host-notifications-share-routing-and-are-scoped-by-grant-bindings.md) ([#227](https://github.com/odogono/odgn-talk/issues/227)); specification and implementation remain pending.
