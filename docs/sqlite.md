# Using SQLite in NorthTalk

NorthTalk's SQL library is the optional `sqlite` Standard Capability. A Host
opens a database and grants a Script access to it; the Script calls `query`,
`change`, `begin`, `commit` and `rollback`. Scripts never receive a database
path or connection handle. Use it for records that need filtering, joins or
aggregates; use [`store`](../spec/07-libraries-and-the-standard-library.md#store)
when values under text keys are enough.

This guide covers Script usage, Host setup and the implementation. The
[library specification](../spec/07-libraries-and-the-standard-library.md#sqlite)
defines the behavior, and the [embedding specification](../spec/09-embedding.md#the-sqlite-factory)
defines the Host contract. Current platform support and limitations live in
the [TS guide](../impl/ts/README.md#the-group-and-trace-cases) and
[Go guide](../impl/go/README.md#sqlite-standard-capability).

## Querying and changing rows

Assume the Host grants access as `db` and creates a table
`notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`.

```talk
on addNote body
  ask db to change "INSERT INTO notes (body) VALUES (?) RETURNING id", [body], 1
  return the rows of it
end addNote

on findNote noteId
  ask db to query "SELECT id, body FROM notes WHERE id = :id", {id: noteId}, 1
  return it
end findNote
```

`query` returns a list of maps, such as `[{id: 1, body: "Hello"}]`, or `[]`
when nothing matches. Each map's keys follow the SQL column order. Give joined
columns distinct names with `AS`: duplicate result names raise `sql`.

`change` returns `{changes, rows}`. `changes` counts inserted, updated or
deleted rows; `rows` holds a `RETURNING` result, or `[]`. Use `RETURNING id`
when you need generated ids; there is no last-inserted-id Operation.

Pass values separately from SQL text. Lists bind `?` or `?NNN`; maps bind
`:name` using keys without the colon. Do not interpolate user input into SQL.
Each call accepts exactly one statement and requires matching parameters.
Mixing named and positional placeholders, or using `@name` or `$name`, raises
`sql`. Use `[]` for a statement without parameters.

The third argument, `max`, limits **returned rows**, not affected rows.
Omitting it, or passing Nothing, uses the Grant's `maxRows`. Exceeding it
raises `too many rows`; results are never silently truncated. For pagination,
put `ORDER BY` and `LIMIT` in the SQL itself. A `change` with no `RETURNING`
can pass `0` even when it updates many rows:

```talk
on editNote noteId, body
  ask db to change "UPDATE notes SET body = ? WHERE id = ?", [body, noteId], 0
  return the changes of it
end editNote
```

Current implementations charge each `query` and `change` its Operation cost plus
`max × perRow` Fuel before execution, regardless of how many rows come back.
Choose a small `max` when the result size is known. The specified
[step-metering contract](../spec/embedding/metered-operations.md#sqlite-step-authorization)
replaces this with `perStep`, including completion and overflow probes, but is
not yet implemented; see the [Go support note](../impl/go/README.md#ordinary-capability-operations)
and [TS support note](../impl/ts/README.md#process-wide-core-and-host-manifests).

## Values crossing the SQL boundary

Nothing becomes SQL `NULL`, text becomes `TEXT`, Bytes become `BLOB`, and
booleans become integers 1 and 0. A number whose canonical text has no fraction
digits and fits a signed 64-bit integer becomes `INTEGER`; other numbers
become `REAL`, rounded to the nearest double. For example, `3` binds as an
integer while `3.0` binds as a real. Lists, maps and other unsupported values
must be converted explicitly before binding.

Results reverse that mapping, except that booleans come back as numbers and
text is normalized to NFC. `REAL` values become the shortest decimal that
round-trips to the same double, so SQL floating-point arithmetic does not
preserve arbitrary decimal precision. Non-finite or oversized real results
and invalid text raise `unrepresentable`. See the Core guides linked above
for runtime-specific text restrictions.

## When changes become permanent

A **Segment** is the part of a Run between Suspension Points. Returning from a
handler ends its final Segment; a `wait` ends the current Segment before the
Run resumes. Fuel-slice preemption does not end a Segment.

Every `change` belongs to its Segment's database transaction, even without an
explicit `begin`. Changes become visible to other Segments when that Segment
commits. Within it, the writer reads its own pending changes.

Use `begin` when several statements must be discarded together on an ordinary
Script error:

```talk
on moveBalance fromId, toId, amount
  ask db to begin
  ask db to change "UPDATE accounts SET balance = balance - ? WHERE id = ?", [amount, fromId], 0
  if the changes of it is 0 then throw {code: "missing account", id: fromId}
  ask db to change "UPDATE accounts SET balance = balance + ? WHERE id = ?", [amount, toId], 0
  if the changes of it is 0 then throw {code: "missing account", id: toId}
  ask db to commit
end moveBalance
```

This example assumes an `accounts (id INTEGER PRIMARY KEY, balance INTEGER
NOT NULL)` table. The Host can add constraints for its own balance rules.

`begin` opens a `transaction` Capability Scope backed by a savepoint.
`commit` closes that scope and keeps its changes **inside the Segment**;
`rollback` closes it and discards its changes. An ordinary error while the
scope is open abandons it automatically. Changes made before `begin` are
outside that savepoint and can still commit. Ordinary errors do not roll back
an entire Segment; Limit Faults, cancellation, Stop and Rewind do, including
changes whose explicit `commit` already ran.

An open transaction scope cannot cross a `wait`, suspending call or Join.
Use the Operations above for transaction control; raw SQL `BEGIN`, `COMMIT`,
`ROLLBACK`, `SAVEPOINT` and `RELEASE` are denied. Deferred constraints are
checked at the Segment's commit, so a deferred failure ends the Run as
`effect failed`, rather than failing the Script's `commit` call.

Only one Segment can hold a database's write lock. A competing write raises
`sqlite busy` immediately; reads still see committed data. A Script can catch
that error and retry after a `wait`, once any transaction scope has closed.
All Grants for the same database share a coordinator. Writing to a second
database in the same Segment raises `segment participant conflict`.

## Offering SQLite from a TypeScript Host

The package's `@odgn/northtalk/sqlite` entry point supplies the database
implementation, while `@odgn/northtalk` supplies the Core's factory. This example
imports the local sources so it can run directly from this checkout. It uses a
temporary database and runs one handler to completion. From the repository
root, run `bun install`, save it as `sqlite-example.ts`, then run
`bun sqlite-example.ts`.

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newGroup, parseInstant, sqliteCapability } from './impl/ts/src/index';
import { openSqliteDatabase, sqliteDatabases } from './impl/ts/src/sqlite/index';

const directory = mkdtempSync(join(tmpdir(), 'northtalk-sqlite-'));
const db = openSqliteDatabase(join(directory, 'notes.sqlite'));
try {
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  const sqlite = sqliteCapability(
    sqliteDatabases({ app: db }),
    {
      query: { fuel: 4 },
      change: { fuel: 4 },
      begin: { fuel: 4 },
      commit: { fuel: 4 },
      rollback: { fuel: 4 },
    },
    1,
  );
  const group = newGroup({ name: 'notes' });
  const script = group.load({
    name: 'writer',
    source: `on start
  ask db to change "INSERT INTO notes (body) VALUES (?) RETURNING id", ["Hello"], 1
  return the rows of it
end start`,
    grants: {
      db: sqlite.grant('all', {
        database: 'app',
        tables: ['notes'],
        maxRows: 100,
      }),
    },
  });
  script.deliver({ name: 'start' });
  const result = group.pump(parseInstant('2026-10-12T12:00:00Z'));
  console.log(result.reports);
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
```

The costs above are example Host policy. Supply a cost for all five Operations.
For a read-only Script, grant `['query']` instead of `'all'`. `tables` limits
table access; omitting it allows all tables except a co-located Store's table.
`database: 'app'` refers to the Host's registry key, not a filesystem path.

`db.exec` is a trusted Host operation outside Script authorizers and Segments;
use it for setup or migrations before running Scripts. A long-lived Host must
finish or stop and pump its active Scripts before closing the database.
Database contents are external state and are not included in a Script save.

For Go, the separate `impl/go/sqlite` module provides `sqlite.Open` and
`sqlite.Databases`; pass its implementation to `Core.SqliteCapability` and use
`SqliteBinding` for Grants. The [Go guide](../impl/go/README.md#sqlite-standard-capability)
and [Host integration tests](../impl/go/sqlite/host_test.go) show the API and
concurrency rules.

## How the implementation works

The Core's [TS factory](../impl/ts/src/sqlite-capability.ts) and
[Go factory](../impl/go/sqlite_capability.go) define the same Operations. They
validate bindings and arguments, charge Fuel, convert NorthTalk values to SQL
values, enroll Segment-bound Operations, manage transaction scopes and convert
returned rows into maps. The Host implementation owns database connections,
statement execution, authorization and transaction lifecycle hooks.

The [TS database](../impl/ts/src/sqlite/database.ts) and
[Go database](../impl/go/sqlite/database.go) each keep a writer connection and
a read-only connection in WAL mode. A coordinator's Segment-begin hook prepares
state without locking. The first `change` or `begin` acquires the writer with
`BEGIN IMMEDIATE`. Reads from that Segment use the writer; other reads use the
reader. The coordinator commits or rolls back the outer transaction when the
Segment ends. An exclusive lock on a sidecar database, `<path>-lock`, prevents
a second Host open of the same file until the first closes it.

Script transaction scopes use savepoints inside the outer transaction. Each
`change` also uses an internal savepoint so a statement failure, including a
`RETURNING` result exceeding `max`, can discard that call's changes.

The statement layer checks for one statement and matching placeholders, then
binds values through SQLite's parameter interface. Its authorizer enforces the
Grant's table restrictions and denies transaction SQL, attachment, extension
loading and unsupported PRAGMAs. The Go Host uses SQLite's read-only statement
check and prepare tail; the TS Host uses an
[SQL scanner](../impl/ts/src/sqlite/scan.ts) and authorizer events because its
driver does not expose those interfaces. The Core guides record the resulting
runtime limitations.

In the TS Host, opening with `{ stores: quotas }` also exposes `db.stores`.
Pass it to `storeCapability` and register the database with `sqliteDatabases`
to commit Store writes and SQL changes through the same coordinator. The
Store's backing table is inaccessible through SQL Grants. See the
[SQLite Store example](../impl/ts/examples/store-sqlite/README.md); the Go Host
does not currently keep co-located Stores.

## Checking behavior

The language-neutral [sqlite test kit](../corpus/sqlite-kit/README.md) checks
real database implementations for value conversion, parameters, authorization,
row limits, savepoints, Segment commits and contention. Core Trace Cases under
[`corpus/capabilities`](../corpus/capabilities/) use `sqlite` Stubs to check
the Core independently of a database. The
[TS Host tests](../impl/ts/tests/sqlite-host.test.ts) and
[Go Host tests](../impl/go/sqlite/host_test.go) exercise the complete path from
Script execution to committed database state.

Follow the [TS task map](../impl/ts/NAVIGATION.md) for test prerequisites, then
run these from the repository root:

```sh
bun test impl/ts/tests/sqlite-capability.test.ts impl/ts/tests/sqlite-kit.test.ts impl/ts/tests/sqlite-host.test.ts
go -C impl/go/sqlite test ./...
```
