# A Store key is reserved while a Segment holds an uncommitted write

A Run preempted by its Fuel Slice is still in its Segment, and other Scripts run and commit meanwhile, so a Store write (ADR 0050) can wait uncommitted while another Segment writes the same key. Without a rule, a `swap` that returned `true` would then overwrite a value it never compared against. So an uncommitted `set`, `delete` or `swap` reserves its key until its Segment commits or rolls back, and another Segment's write to a reserved key raises `store busy`, a catchable error, before anything changes. We chose this so `swap` stays atomic, as the Store's promise needs, and so the conflict surfaces at the call, where a Script can catch it and retry, rather than at commit.

## Considered Options

- **Commit applies the value unconditionally:** the simplest, but `swap` loses its guarantee exactly when two Scripts race, which is when it matters.
- **Commit rechecks `expected`:** a mismatch fails the commit, which ends the Run as `effect failed` with no catch. ADR 0050 rejected optimistic detection for this reason.
- **Atomic only where Segments aren't preempted:** true of Sessions, but a Host with a Fuel Slice gives no guarantee, and a portable Script can't tell which it is on.
- **Blocking the second writer:** the Store's Operations are immediate, so a call can't wait.

## Consequences

- **What reserves:** an uncommitted `set`, `delete` or `swap` that wrote. A `swap` that gives `false` wrote nothing and reserves nothing. Pending increments reserve a key against `set`, `delete` and `swap` from other Segments, but not against their increments, since deltas commute.
- **`store busy`** has the field `{key}`, and the Core adds `capability` and `operation`. It is raised before the Operation changes anything.
- **Reads** are never blocked. Another Segment reading a reserved key, or listing `keys`, sees the last committed state.
- **Lifetime:** reservations end at the Segment's commit or rollback. A Segment ends at its next Suspension Point, so only preemption lets one outlive a single stretch of execution, and a Session, with no Fuel Slice, never raises `store busy`.
- **Space is reserved too:** the quota check at a call counts the committed contents and every live Segment's pending growth, so a commit never overflows into `effect failed`. `increment` never changes a value's logical size.
- **Scope:** reservations live in the Host process that owns the Store. A SQLite Store's file belongs to one process, and two browser tabs sharing one `localStorage` Store are unsupported.
- Amends [ADR 0050](0050-the-store-is-a-standard-capability-with-segment-bound-writes.md), whose "last write wins between plain writes" now holds only between writes of different Segments that don't overlap.
