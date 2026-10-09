# Named-statement catalogues for `sqlite`

Answers [#473](https://github.com/odogono/odgn-talk/issues/473), part of [#475](https://github.com/odogono/odgn-talk/issues/475). Checked on 2026-10-09 against revision `ecbaf5e`. This is a design recommendation, not an accepted ADR or implemented behavior.

[ADR 0070](../adr/0070-sqlite-is-an-optional-standard-capability-with-segment-bound-writes.md) deferred named statements, each "a declared Operation with closed Shapes", because "a Standard Capability's Operations are fixed, and a catalogue per schema needs a factory that declares Operations per database" (line 9). It rejected a generic `run name, params` Operation over a catalogue as "the generic Operation ADR 0012 warns against" (line 10, [ADR 0012](../adr/0012-capabilities-are-called-through-tell-and-ask.md) line 9). This note settles how the `sqlite` factory declares one Operation per statement, what the Host Manifest and Group Fingerprint carry, and whether untrusted Scripts should get only catalogues. It also says how catalogues interact with the load-time Validate hook ([#471](https://github.com/odogono/odgn-talk/issues/471), [research note in PR #529](https://github.com/odogono/odgn-talk/pull/529), `docs/research/load-time-validate-hook.md` on that branch).

## Summary

- **1. How the Standard Capability declares Operations per catalogue.** Give the `sqlite` factory an optional catalogue. Each factory call returns one Capability, still named `sqlite`, that declares the five fixed Operations and one Operation for each statement. The Spec does not fix the statement names. It fixes the rule that turns a catalogue entry into an Operation Declaration, so both Cores derive the same declaration from the same entry. The declarations depend only on the catalogue, never on a database:
  - A `read` statement is immediate and not Segment-bound. A `write` statement is immediate and Segment-bound.
  - The argument is one closed map of the statement's named parameters, or no argument when the statement has none.
  - The result is a list of closed row maps, or an Optional row for a `one` statement. A `write` gives `{changes, rows}`.
  - The row cap `max` is fixed per statement, so the per-row charge folds into the declared cost.

  Checks that need the schema run once per Grant, when the Grant is created and the factory already calls `coordinator` ([`09-embedding.md:150`](../../spec/09-embedding.md)). The implementation prepares each statement under the binding's authorizer, and a failure is Host Error `invalid value`. That catches a `read` statement that could write, tables outside the binding, placeholders that don't match the declared parameters, and columns that don't match the row Shape.
- **2. The Host Manifest and Fingerprint.** A catalogue Operation is an ordinary Operation Declaration, so the manifest and the Fingerprint carry its name, Shapes, mode, cost, errors and `segmentBound` with **no change to the data model** ([`09-embedding.md:210-214`](../../spec/09-embedding.md)). Leave the SQL text and any hash of it out of both. They are the implementation, like a Host function, and the Trace already records every result ([`07-…:872`](../../spec/07-libraries-and-the-standard-library.md)). So portability is per catalogue *declaration*: a Script runs unchanged on any Host whose Grant declares the same statements.
- **3. Untrusted Scripts.** Recommend, but don't require, that untrusted Scripts get only catalogue Operations, plus `begin`, `commit` and `rollback`. The allowlist already expresses this, since "Raw access is the allowlist's business" (ADR 0070 line 30). Raw `change` can still `DROP` or `ALTER` any table inside the binding's limits, and raw `query` can read every row and column of them. A catalogue limits a Script to statements the Host wrote.
- **#471:** catalogue Operations take no SQL argument, so the Validate hook has nothing to check for them. Their Grant-creation check is the schema-aware check the pure hook can't make. Catalogues don't change the Operation Declaration data model, so #471 doesn't need to wait for them. The hook still pays for itself on raw `query` and `change` in trusted Scripts.

### A catalogue file

This is a sketch. It uses an annotated `.sql` file in the style of sqlc's `-- name: <name> <command>` ([sqlc query annotations](https://docs.sqlc.dev/en/latest/reference/query-annotations.html)) and HugSQL's `:name` header ([HugSQL file conventions](https://www.hugsql.org/hugsql-in-detail/sql-file-conventions)). Parameters and columns may only be SQL values, so a field's Shape is always one of a few kinds or an Optional one. A field list is therefore enough, and no general Shape notation is needed.

```sql
-- name: findCustomer :read one
-- params: id number
-- row: id number, name text, email optional text
SELECT id, name, email FROM customers WHERE id = :id;

-- name: recentOrders :read max 50
-- params: customer number, since text
-- row: id number, total number, placed text
SELECT id, total, placed FROM orders
WHERE customer = :customer AND placed >= :since ORDER BY placed DESC;

-- name: addOrder :write max 1
-- params: customer number, total number, placed text
-- row: id number
INSERT INTO orders(customer, total, placed) VALUES (:customer, :total, :placed) RETURNING id;
```

The declarations this derives, in the Host Manifest's data model:

| Operation | mode | args | result | segmentBound | errors |
|---|---|---|---|---|---|
| `findCustomer` | immediate | `[{map: [id number]}]` | `{optional: {map: [id number, name text, email optional text]}}` | – | `sql`, `not read-only`, `too many rows`, `unrepresentable` |
| `recentOrders` | immediate | `[{map: [customer number, since text]}]` | `{list: {map: [id, total, placed]}}` | – | as above |
| `addOrder` | immediate | `[{map: [customer, total, placed]}]` | `{map: [changes number, rows {list: {map: [id number]}}]}` | `true` | `sql`, `constraint`, `sqlite busy`, `too many rows`, `unrepresentable` |

### A Script

```talk
on placeOrder customerId, total, placed
  ask orders to findCustomer {id: customerId}
  if it is nothing then throw {code: "no customer", id: customerId}
  ask orders to begin
  ask orders to addOrder {customer: customerId, total: total, placed: placed}
  put item 1 of the rows of it into order
  ask orders to commit
  return the id of order
end placeOrder
```

The Grant `orders` allows `findCustomer`, `addOrder`, `begin`, `commit` and `rollback`, and doesn't allow `query` or `change`. The loader rejects `ask orders to addOrder {customer: 1}` as `wrong argument`, because a literal closed map's keys are checked at load ([`09-embedding.md:113`](../../spec/09-embedding.md)). It rejects `ask orders to change "DROP TABLE orders", []` as `unknown operation`. No SQL text appears in the Script.

## What exists today

Verified:

- **Declarations are fixed per Standard Capability.** "A Capability whose Operation Declarations the spec fixes" ([`CONTEXT.md:35-36`](../../CONTEXT.md)). The `sqlite` factory takes an implementation, the cost map and `perRow` ([`09-embedding.md:145`](../../spec/09-embedding.md)), and declares exactly `query`, `change`, `begin`, `commit` and `rollback` ([`07-…:858-864`](../../spec/07-libraries-and-the-standard-library.md)).
  - In TS, the factory builds the five Operations and calls `defineCapability<SqliteBinding>('sqlite', operations, {coordinator})`, then freezes them with `fixed` ([`sqlite-capability.ts:370-443`](../../impl/ts/src/sqlite-capability.ts)).
  - In Go, it calls `DefineCoordinatedCapability("sqlite", …)` ([`sqlite_capability.go:164`](../../impl/go/sqlite_capability.go)).
- **No Standard Capability declares Operations from data.** `clock`, `timer` and `console` are hard-coded ([`standard_capability.go`](../../impl/go/standard_capability.go)), and so are `calendar`, `locale` and `store` ([`calendar_capability.go:56`](../../impl/go/calendar_capability.go), [`locale_capability.go:83`](../../impl/go/locale_capability.go), [`store_capability.go:79`](../../impl/go/store_capability.go)). Only Host-defined Capabilities are built from data:
  - The Go Session Host builds Operations from mocks ([`session/host.go:225-256`](../../impl/go/session/host.go)).
  - The corpus runners build them from `case.toml` `[operations]` ([`internal/corpus/operations.go:240-242`](../../impl/go/internal/corpus/operations.go)).
  - Canvas registers fixed typed Operations through the Session extension seam ([ADR 0052](../adr/0052-canvas-is-a-deterministic-host-capability.md)).
- **The Core's private checks are already per Operation.** Go's `operationChecks` are "private refinements installed only by Standard factories" ([`capability.go:46-53`](../../impl/go/capability.go)). TS's `registerStandardChecks(op, …)` keys them by the Operation object ([`standard-capability-checks.ts:16`](../../impl/ts/src/standard-capability-checks.ts), [`sqlite-capability.ts:428`](../../impl/ts/src/sqlite-capability.ts)). Catalogue Operations can reuse the `params`, row and failure checks without a new seam.
- **`DefineCapability` doesn't require a unique name.** The spec says "once per process" ([`09-embedding.md:122`](../../spec/09-embedding.md)), but Go's `defineCapability` keeps no registry by name ([`capability.go:94-175`](../../impl/go/capability.go)). Grants and the Fingerprint are keyed by the granted name, with the Capability name as a field ([`09-embedding.md:212-213`](../../spec/09-embedding.md)). The corpus does refuse a Capability declared twice: `case.toml` refuses the same Standard Capability twice ([`11-…:587`](../../spec/11-the-trace-and-conformance.md)), and the TS replay throws `Duplicate Capability` ([`replay.ts:480-483`](../../impl/ts/src/replay.ts)).
- **A Grant's binding is mapped once, at Grant creation.** The factory checks it there and calls `coordinator(database)` ([`09-embedding.md:147,150`](../../spec/09-embedding.md), [`sqlite-capability.ts:421-425`](../../impl/ts/src/sqlite-capability.ts)). This is the first point at which the database is known.
- **Each call prepares afresh under the binding's authorizer:**
  - Go sets the authorizer, prepares, refuses trailing statements and checks `stmt.ReadOnly()` ([`sqlite/statement.go:121-149`](../../impl/go/sqlite/statement.go)).
  - TS runs on `node:sqlite`, not `bun:sqlite` ([`sqlite/database.ts:1-9`](../../impl/ts/src/sqlite/database.ts)). `node:sqlite` doesn't expose `sqlite3_stmt_readonly`, so TS infers "could write" from the authorizer actions it sees ([`database.ts:86-88,555`](../../impl/ts/src/sqlite/database.ts)).
  - Nothing caches prepared statements.
- **The authorizer denies no DDL on allowed tables.** It denies the transaction statements, `ATTACH`, `DETACH`, `VACUUM INTO`, `load_extension`, most `PRAGMA`s and tables outside `tables` ([`09-embedding.md:161`](../../spec/09-embedding.md)). `DROP TABLE` or `ALTER TABLE` on an allowed table passes.
- **Cost.** `query` and `change` charge `max × perRow` through `Charge` before the work, because `max` is a run-time argument ([`09-embedding.md:149`](../../spec/09-embedding.md), [`sqlite-capability.ts:335`](../../impl/ts/src/sqlite-capability.ts)).

What SQLite gives at prepare time (verified on sqlite.org):

- `sqlite3_stmt_readonly` "returns true … if and only if the prepared statement X makes no direct changes to the content of the database file". It is true for `BEGIN`, `ATTACH` and an application function's indirect writes, and may be false for a no-op write ([stmt_readonly](https://www.sqlite.org/c3ref/stmt_readonly.html)). It needs a prepared statement, and so the schema.
- `sqlite3_bind_parameter_count` and `sqlite3_bind_parameter_name` give each placeholder with its prefix (`:AAA`, `?NNN`), and NULL for a bare `?` ([bind_parameter_name](https://www.sqlite.org/c3ref/bind_parameter_name.html)). So a catalogue's parameter names can be checked exactly. Their types can't: SQLite has no interface for a parameter's type.
- `sqlite3_column_decltype` gives a table column's declared type and NULL for an expression. "Just because a column is declared to contain a particular type does not mean that the data stored in that column is of the declared type" ([column_decltype](https://www.sqlite.org/c3ref/column_decltype.html)). Only `STRICT` tables (3.37.0+, below the 3.45 floor) refuse a value that doesn't convert, with `SQLITE_CONSTRAINT_DATATYPE` ([STRICT tables](https://www.sqlite.org/stricttables.html)). So **row Shapes can't be inferred or proved statically**. Column count and names can be checked after prepare.
- After a schema change, `sqlite3_step` "will automatically recompile the SQL statement" ([prepare](https://www.sqlite.org/c3ref/prepare.html)). The authorizer is invoked only at prepare, and at that re-prepare, so "the application should ensure that the correct authorizer callback remains in place during the sqlite3_step()" ([set_authorizer](https://www.sqlite.org/c3ref/set_authorizer.html)).
- Go's driver exposes `ReadOnly`, `BindCount`, `BindName`, `ColumnCount`, `ColumnName` and `ColumnDeclType` (`ncruces/go-sqlite3` v0.35.6, `stmt.go:74,168,186,368,376,398`). `node:sqlite`'s `statement.columns()` gives `name` and the declared `type` ([Node `sqlite`](https://nodejs.org/api/sqlite.html)).
- Prior art: sqlc reads the schema and generates typed code from annotated queries ([sqlc docs](https://docs.sqlc.dev/en/latest/howto/select.html)). That is static inference outside the database, which ADR 0028 would make non-normative tooling here. This note asks the catalogue author to declare Shapes instead.

## 1. Declaring Operations per catalogue

### The factory

- **Go:** `SqliteCapability(impl, costs, perRow, opts ...SqliteOption)`, with `WithCatalogue([]SqlStatement)`. **TS:** `sqliteCapability(impl, costs, perRow, {catalogue})`. Without a catalogue, behavior is unchanged.
- **Data, not a file:** the normative input is a list of entries `{name, sql, kind, one, max, params, row}`. Parsing the `.sql` file is a helper that lives in the Host modules ([`impl/go/sqlite/`](../../impl/go/sqlite/) and [`impl/ts/src/sqlite/`](../../impl/ts/src/sqlite/)). That keeps the Go Core free of dependencies ([`impl/go/go.mod`](../../impl/go/go.mod)). Helpers are outside parity ([`09-embedding.md`](../../spec/09-embedding.md), "Outside parity"). Tooling never parses the catalogue, because it reads the declarations from the Host Manifest.
- **Factory checks, without a database,** each Host Error `invalid value`:
  - A statement name that is empty, duplicated, one of the five fixed names, or refused (`ask`, `tell`, `send`, `wait`, `end`; [`capability.go:97`](../../impl/go/capability.go)).
  - A field Shape other than `number`, `text`, `bytes`, `boolean` or `nothing`, each optionally Optional. A row may not use `boolean`, since SQLite gives 0 or 1 ([`07-…:877`](../../spec/07-libraries-and-the-standard-library.md)).
  - A `max` that isn't a whole number, or `one` with `max` other than 1.
  - A missing cost entry. The cost map must name every statement, as it names every Operation ([`09-embedding.md:130`](../../spec/09-embedding.md)).
- **The derived declaration**, a Spec rule:
  - `mode` is immediate. Segment-bound Operations must be ([`07-…:891`](../../spec/07-libraries-and-the-standard-library.md)).
  - `segmentBound` is true exactly for `write`.
  - `args` is `[{map: params}]` (closed), or `[]` with no parameters.
  - `result` is as in the table above.
  - `errors` are `query`'s or `change`'s without `out of range`, since there is no `max` argument.
  - `cost` is the cost-map entry plus `max × perRow` Fuel, capped at 9,007,199,254,740,991. `max` is fixed, so the declared cost is exact, appears in the Fingerprint, and needs no `Charge`.
- **One Capability per catalogue.** Every catalogue Capability keeps the name `sqlite` and the shared `coordinator(database)` mapping. So Grants on one database share one participant ([ADR 0069](../adr/0069-segment-bound-grants-share-a-participant-through-a-segment-coordinator.md)), whether they use a catalogue or raw SQL. A catalogue `write` and a raw `change` in one Segment therefore commit together, and `begin` covers both.
- **The glossary changes.** "Standard Capability" becomes a Capability whose Operation Declarations the Spec fixes, *or derives by a fixed rule from Host data*, as `sqlite`'s catalogue Operations are.

### At Grant creation

The factory gives the implementation one new method: `prepare(binding, sql) -> {readOnly, params, columns} | ScriptError`. It is called for each catalogue Operation in the Grant, after `checkBinding`. It prepares the statement on a read connection under the binding's authorizer, and never steps it. The factory refuses the Grant with `invalid value`, naming the statement, when:

- the SQL isn't exactly one statement, or the authorizer denies it, which covers denied kinds and tables outside `tables`;
- a `read` statement isn't read-only. Go uses `sqlite3_stmt_readonly`, and TS its authorizer proxy;
- the placeholders aren't exactly the `:name` parameters declared, as a set. `?`, `?NNN`, `@` and `$` are refused, so a catalogue binds only by name;
- the column names aren't the row Shape's keys, in order. Duplicate names are refused here, not per call;
- `max` exceeds the binding's `maxRows`.

The checks are for the Host's own data, so their failures are Host Errors, not Script diagnostics.

### At a call

- **The Core** checks the closed-map Shape, which subsumes [`09-embedding.md:152`](../../spec/09-embedding.md)'s per-value `wrong kind` checks. It converts the map to a name map and calls `impl.query` or `impl.change` with the catalogue's SQL and the statement's `max`. It checks each row against the row Shape, and a mismatch is `host error` ([`09-embedding.md:115`](../../spec/09-embedding.md)). For `one`, it gives the row or Nothing.
- **The Host obligations are unchanged.** The implementation still prepares, authorizes and checks read-only per call, so a later schema change through `Exec` or a raw `change` still fails safely with `sql` or `not read-only`. A Host that caches the prepared statement must keep the binding's authorizer installed while it steps, per the SQLite docs above.

## 2. Host Manifest and Fingerprint

| Item | Manifest | Fingerprint | Reason |
|---|---|---|---|
| Statement name, args, result, mode, errors | yes | yes | ordinary Operation Declaration fields, so no data-model change |
| `segmentBound` | yes | yes, as `true` | existing rule ([`scoped-effects.md:45`](../../spec/embedding/scoped-effects.md)) |
| Cost including `max × perRow` | yes | yes | exact because `max` is fixed |
| `max` on its own | no | no | already inside the cost and the error |
| SQL text, or its hash | no | no | the implementation, like Host functions, which are excluded ([`09-embedding.md:213`](../../spec/09-embedding.md)) |
| Catalogue name | no | no | a Grant's name and declarations identify it |

- **SQL out of the Fingerprint:**
  - **For:** replay never needs it, because the Trace records each result. Restore and lockstep check declarations, which is what Load depends on. A fixed `WHERE` clause or reformatted SQL doesn't force a variables-only restore.
  - **Against:** two Hosts with the same declarations but different SQL pass the lockstep check and give different answers. That is already true of any Host function, and of raw SQL across SQLite versions (ADR 0070 line 23).
- **SQL out of the manifest:** the manifest goes to Script authors and their tooling. SQL text exposes schema that untrusted authors needn't see, and the LSP only needs the Shapes.
- **Conformance:** `case.toml` `[standard]` gains `catalogue`, a list of entries in the data model, with no SQL needed, since Stubs stand for the answers ([`11-…:549`](../../spec/11-the-trace-and-conformance.md)). Stubs are keyed by statement name. A case with two catalogues needs the duplicate rule ([`11-…:587`](../../spec/11-the-trace-and-conformance.md)) relaxed to "one per granted name".
- **Message layer:** `standard-capability` doesn't offer `sqlite` yet ([`09-embedding.md:278`](../../spec/09-embedding.md)). When it does, the catalogue rides along as the same entries.
- **Portability:** a Script depends on statement names and Shapes. It doesn't depend on SQL text, or even the dialect. Result drift between SQLite versions stays as ADR 0070 accepts it.

## 3. Untrusted Scripts

| | Raw `query`/`change` with `tables` | Catalogue only |
|---|---|---|
| Rows reachable | every row and column of allowed tables | only what each statement's `WHERE` and column list give |
| Writes | any DML, and `DROP` or `ALTER` of allowed tables | only the Host's `write` statements |
| CPU per call | unbounded: cost is `max × perRow` whatever the plan. A cross join that returns 0 rows is cheap to call | known to the Host author, statement by statement |
| Load checks | Shapes only, plus the #471 syntax checks | names, parameter keys and kinds |
| SQL injection by concatenation | possible within the binding, which the #470 Lint flags | impossible: no SQL argument |

- **Recommendation:** no new Spec rule. Add advice to chapter 9: "Grant untrusted Scripts only catalogue Operations and `begin`, `commit`, `rollback`." A Go and TS helper, `catalogueOps(def)`, can list them for `Grant`. `GrantsAsUsed` already keeps `rollback` when `begin` is used ([`scoped-effects.md:44`](../../spec/embedding/scoped-effects.md)).
- **Row isolation by tenant** would need parameters bound from the binding, such as `:tenant`, so a Script can't choose them. See Fog.
- **CPU:** `sqlite3_progress_handler` can interrupt a long `sqlite3_step` ([progress_handler](https://www.sqlite.org/c3ref/progress_handler.html)). ADR 0070 doesn't use it. That is #472's question, not this one.

## Interaction with the Validate hook (#471)

- **Catalogue calls don't use the hook.** A catalogue Operation's arguments are SQL values, already checked by literal Shapes at Load. There is no SQL literal to validate.
- **The catalogue check is not a Validate hook.** It reads the database and the binding, which the hook's purity rule forbids. It runs at Grant creation, not Load. Restore re-creates Grants on the Host side, so the check runs again then. Reload and Extend don't re-run it, and don't need to, because the declarations haven't changed.
- **Sequencing:** #471 deferred itself because "both change the Operation Declaration and the Fingerprint". This note finds that catalogues change neither data model, so #471 can proceed independently. Its open question ("whether catalogues make a generic hook unnecessary for `sqlite`") now has an answer: only for Scripts confined to catalogues. Trusted Scripts on raw SQL still gain syntax and denied-kind diagnostics.

## Open questions and Fog

- **File format:** an annotated `.sql` file, which suits SQL editors and sqlc users, or a TOML file in `case.toml`'s data model, which adds no new syntax. Either way, the normative input is the entry list.
- **Row Shape mismatch:** `host error`, as recommended, or a catchable `sql` with a `reason`. `STRICT` tables make a mismatch rare, and the Host guide should recommend them.
- **A `max` argument:** whether a Script may pass a smaller `max` as an Optional argument. That would bring back `out of range` and `Charge`.
- **Binding parameters:** whether entries may name parameters filled from binding data, not from the Script.
- **Schema drift:** a migration after Grant creation can invalidate the Grant-creation check. Per-call checks keep this safe, but the Host isn't told. Should Hosts re-create Grants after a migration?
- **Several catalogues on one database:** which statement names may repeat across catalogues. Separate Capabilities make this harmless, but the Trace's `capability` field is `sqlite` for both, and the named Grant tells them apart.
- **Positional statements:** refused here, for closed maps. Revisit if a single-argument statement wants a bare value.

## Candidate follow-up tasks

1. An ADR amending ADR 0070, plus the glossary change to "Standard Capability".
2. Spec work. Chapter 7 needs the catalogue rule. Chapter 9 needs the factory option, `prepare`, the Grant-creation checks and the untrusted-Script advice. Chapter 11 needs `[standard] catalogue` and the duplicate rule.
3. Corpus: `standard-sqlite-catalogue*` Trace Cases for declarations, Shapes, `one`, cost and `host error` on a bad row. Sqlite-kit cases for `prepare`'s refusals.
4. The TS Core and Host: the factory option, plus `prepare` on `node:sqlite` with the authorizer proxy for read-only.
5. The Go Core and Host: the same on `ncruces/go-sqlite3`.
6. A catalogue parser helper in both Host modules, with shared parse fixtures.
7. Tooling: the LSP completes statement names and parameter keys from the manifest. Nothing new is needed beyond the existing declarations.
