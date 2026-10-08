# `sqlite` is an optional Standard Capability with Segment-bound writes

A Script that keeps records it needs to search, join or total has outgrown the Store's whole values under text keys, and the Milestone 2 Bun Host already plans a synchronous database as an immediate Operation. `sqlite` becomes a Standard Capability that a Host may choose not to offer: a Host that offers it gives every Script the same Operations, SQL dialect, value mapping and errors. Its Grant binding names a database. Scripts run raw SQL with bound parameters through `query` and `change`, and open a transaction with `begin`, closed by `commit` or `rollback`. Writes are Segment-bound (ADR 0048), and the transaction is a Capability Scope (ADR 0047) inside the Segment's participant, so a Limit Fault rolls back the database with the Script Variables, and an ordinary error rolls back an unfinished transaction. We chose SQLite because it runs in-process, so its Operations can be immediate, which Segment-bound effects and Capability Scopes need, and because naming the dialect lets the Spec state its rules exactly. Settled in [#218](https://github.com/odogono/odgn-talk/issues/218). Until the Spec holds the rules, the Consequences below record them.

## Considered Options

- **A Host-defined Capability in the Bun Example Host:** SQL dialects aren't portable, so a `db` Capability fails the test the Store passed. But Scripts that keep records are ordinary work, and the Go server and Bun Hosts should run them unchanged. Making the Capability optional keeps Hosts with no database honest without leaving every Host to invent its own shape.
- **A generic `db` over a portable SQL subset:** other engines could serve it, but the subset is large to specify, and transactions, savepoints and contention differ by engine. A generic `db` whose dialect is the Host's makes raw SQL unportable.
- **Named statements only,** each a declared Operation with closed Shapes: the loader checks every call and no SQL text appears in Scripts. But a Standard Capability's Operations are fixed, and a catalogue per schema needs a factory that declares Operations per database. Deferred, not rejected.
- **A generic `run name, params` Operation over a catalogue:** the generic Operation ADR 0012 warns against, checked only at run time until a load-time validation hook exists.
- **Every Segment as the transaction, with no `begin`:** simpler, but an uncaught ordinary error commits the participant (ADR 0048), so `transfer`'s `throw` after its debit would commit the debit.
- **`begin` and `commit` as a plain Capability Scope:** an explicit `commit` would be final even when a later Limit Fault rolls back the Script Variables, and a Rewind (ADR 0068) would repeat committed writes.
- **Ending the Run as `effect failed` on contention,** or suppressing preemption while a Segment holds the write lock: ADR 0050 rejected an uncatchable conflict, and ADR 0049 rejected suppressing preemption.
- **Atomic writes across several database files,** by ordered commit or `ATTACH`: ordered commit can publish partly, which ADR 0048 rules out, and SQLite doesn't commit attached databases atomically in WAL mode.
- **Binding non-integer numbers as exact `TEXT`, or refusing them:** column affinity converts numeric text to `REAL` anyway, and refusing them surprises anyone who writes a price.
- **Charging for the rows a query returns:** `Charge` happens before the work, so a Host can't meter rows as they arrive. Metered Operations are a follow-up.
- **Leaving the Store and `sqlite` on separate coordinators:** a Script that keeps settings in the Store and records in `sqlite` would hit `segment participant conflict` in every Handler that writes both.

## Consequences

- **Optional:** a Host need not offer `sqlite`, and chapter 7 says which Standard Capabilities are optional. A Host that offers it follows every rule here. The v1 Hosts are the Bun server and Go server Hosts. Sessions and the Playground follow later, through native SQLite and sqlite-wasm in the Playground's worker.
- **Dialect:** SQLite 3.45.0 or later. Ubuntu 24.04 LTS ships 3.45.1 and 26.04 LTS ships 3.46.1, so a Host may link the system library on either. The design itself needs only 3.35.0, for `RETURNING`. 3.45 also gives Scripts built-in JSON, `RIGHT` and `FULL OUTER JOIN`, `IS DISTINCT FROM` and `ORDER BY` inside aggregates. A Host may run a newer SQLite, and portable Scripts use the 3.45 surface.
- **Results may drift between versions:** a newer SQLite can change what existing SQL gives. For example, 3.53 raised the digits of a `REAL` cast to text from 15 to 17. So raw SQL is portable only up to the Host's SQLite version. The value mapping below converts doubles itself and isn't affected, and a Trace replays exactly because it records results.
- **Binding:** the Grant binding names a database the Host keeps. Binding data may limit the tables a Grant can use and sets the most rows a call may return. Scripts never see paths or handles.
- **Operations,** all immediate:
  - `query sql, params[, max]` gives a list of row maps. It must be read-only, and never enlists a participant.
  - `change sql, params[, max]` gives `{changes, rows}`, where `rows` holds what a `RETURNING` clause gives, and is empty without one. Segment-bound. There is no `lastId`, which is meaningless for a multi-row insert. `RETURNING` gives the ids instead.
  - `begin` opens the scope `transaction`, with `abandon = rollback`. `commit` and `rollback` close it. All three are Segment-bound.
  - `params` is a list for `?` placeholders or a map for `:name` ones.
  - Raw access is the allowlist's business: a Grant of only `query` is read-only.
- **Transactions:** a Script's `begin` and `commit` work as a savepoint inside the Segment's transaction. An explicit `commit` stays provisional until the Segment commits. An ordinary error abandons an open transaction, then commits the Segment. A Limit Fault, cancellation, Stop or Rewind rolls back everything. Without `begin`, `change` still commits or rolls back with its Segment.
- **Segment Coordinators** (ADR 0069): one per database. Grants on one database share it, aliases included. A Segment that writes to two databases raises `segment participant conflict`.
- **Contention:** the coordinator's `begin` hook only prepares the Segment's state, because a failed `begin` hook raises `host error`. The Operation itself takes SQLite's write lock, at the first `change` or `begin`. If another Segment holds it, the Operation raises `sqlite busy` before anything changes. Only a Run preempted inside its Segment holds the lock while another Script runs, so a Host without a Fuel Slice never raises it. A Script catches it and retries after a `wait`. Reads are never blocked. A Segment that holds the lock reads its own uncommitted writes, and others read the last committed state.
- **Safety:** the Host obligations below are tested by the Host kit.
  - One statement per call. Trailing statements raise `sql`.
  - Parameters are always bound, never spliced into the SQL text.
  - The authorizer denies `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `ATTACH`, `DETACH`, `VACUUM INTO`, `load_extension`, and every `PRAGMA` outside a short read-only list, and enforces the binding's table limits.
  - `query` is checked with `sqlite3_stmt_readonly`.
- **Values in** (ADR 0030): `nothing` binds as `NULL`. A number that is an integer with exponent 0 and fits int64 binds as `INTEGER`, and any other number as `REAL`, by the nearest double. Text binds as `TEXT`, bytes as `BLOB`, and `true` and `false` as 1 and 0. Every other kind raises `wrong kind`, and Scripts convert explicitly (ADR 0003).
- **Values out:** `NULL` gives `nothing` and `INTEGER` a number. `REAL` gives the shortest decimal that reads back as the same double, then the number rules. NaN, the infinities and magnitudes of 10^34 or more raise `unrepresentable`. `TEXT` gives NFC text and `BLOB` gives bytes. Duplicate column names in a result raise `sql`.
- **Cost:** a call charges `max × perRow` before the work, where `max` defaults to the binding's cap and can't exceed it. A result with more rows than `max` raises `too many rows`. Results are never truncated. The returned rows are charged to the Run's Allocation Budget.
- **Errors:** `sql`, `constraint` with `{kind}`, `sqlite busy`, `readonly`, `too many rows` and `unrepresentable`, plus the scope errors of ADR 0047.
- **The Store in the same database:** a Host may keep its Stores in a `sqlite` database and map both to that database's coordinator. The Bun Host does this in v1. The Store's commit then writes on the Segment's connection inside its transaction, and:
  - the Store and `sqlite` share one connection manager per database. The Host process still owns the file, as ADR 0062's in-process reservations need, but no longer holds SQLite's exclusive lock;
  - the authorizer denies the Store's table to every `sqlite` Grant, for reads too, since the engine's copy and the table's encoding are the Host's;
  - a Store write enrolled with a coordinator it shares with `sqlite` takes the write lock at its call, as `change` does, so a commit never finds the database busy. When another Segment holds the lock, it raises `store busy` with `{key}`. This widens ADR 0062's `store busy` to "the key is reserved, or the Store's storage is held by another Segment's transaction".
- **Tooling:** a Lint flags Interpolated Text passed as the SQL of `query` or `change`, and points to bound parameters.
- **Trace and conformance:** every result is in the Trace, so a Trace Case replays without a database. Trace Cases cover the Core's side with Stubs and lifecycle Stubs. A language-neutral Host kit, like the Store's, holds each Host to the safety, value, contention and transaction rules.
- **Snapshots** never include the database. An open transaction or an enlisted participant makes Save return `effects pending` (ADR 0049).
- **Depends on** the Segment Coordinator work in both Cores and the Stores ([#459](https://github.com/odogono/odgn-talk/issues/459), [#460](https://github.com/odogono/odgn-talk/issues/460), [#461](https://github.com/odogono/odgn-talk/issues/461)).
- **Follow-ups:**
  - Named-statement catalogues.
  - A load-time validation hook, so literal SQL becomes a load diagnostic.
  - Metered Operations that charge for rows as they arrive.
  - `sqlite` in Sessions and the Playground.
- **Amended 2026-10-08** ([#466](https://github.com/odogono/odgn-talk/issues/466)): the error raised for a `query` that could write is named `not read-only`, not `readonly`, so it can't be confused with the existing `read only`. Error codes may now contain hyphenated words.
- Amends [ADR 0050](0050-the-store-is-a-standard-capability-with-segment-bound-writes.md) and [ADR 0062](0062-a-store-key-is-reserved-while-a-segment-holds-an-uncommitted-write.md): a Store that shares a coordinator with `sqlite` raises `store busy` while another Segment holds the database's write lock.
