# The sqlite test kit

Statement and lifecycle sequences that every `sqlite` implementation must follow ([chapter 7](../../spec/07-libraries-and-the-standard-library.md#sqlite), [chapter 9's Host obligations](../../spec/09-embedding.md#sqlite-host-obligations), [ADR 0070](../../docs/adr/0070-sqlite-is-an-optional-standard-capability-with-segment-bound-writes.md)). Trace Cases cover the Core's side of `sqlite` through Stubs (`corpus/capabilities/standard-sqlite*`). The database is the Host's, so this kit holds each implementation to the Spec against a real SQLite instead. It is language-neutral data, so every Core's Hosts can reuse it.

These aren't Trace Cases, and the corpus runners skip this directory. The TS runner is [`impl/ts/tools/sqlite-kit.ts`](../../impl/ts/tools/sqlite-kit.ts), which runs the kit on the TS `node:sqlite` implementation under Bun, Node and Deno. The Go Host (#469) adds one for Go.

## Format

Each `.toml` file lists default `grants` and `[[sequence]]` tables. Each sequence has a `name`, optional `grants` of its own, optional `setup` and `steps`. A runner opens a fresh, empty database for each sequence, runs each `setup` statement on it directly, outside every Segment and with no authorizer, and then runs the steps in order.

`grants` is a table from a Grant's name to `{capability, binding}`. A `sqlite` Grant's binding is `{database, tables, maxRows}`, as [chapter 9](../../spec/09-embedding.md#the-sqlite-factory) gives it, and every sequence uses one `database`, `app`. A `store` Grant's binding is the Store's name, and its Store lives in that database, sharing its coordinator ([chapter 7](../../spec/07-libraries-and-the-standard-library.md#store)).

| Key | Is |
| --- | --- |
| `in` | the Segment the step belongs to, as its Segment id |
| `hook` | `begin`, `commit` or `rollback`, a lifecycle hook of the database's coordinator |
| `do` | `query`, `change`, `begin`, `commit` or `rollback`, a `sqlite` Operation; or `get`, `set`, `delete`, `keys`, `increment` or `swap`, a `store` Operation |
| `grant` | the Grant the Operation goes through, or the Grant a `begin` hook sees, whose call begins the Segment; `db` if absent |
| `sql` | a `query`'s or `change`'s statement |
| `params` | its `params`, as a display-form list or map; `[]` if absent |
| `max` | its `max`, a number; the binding's `maxRows` if absent |
| `args` | a `store` Operation's arguments, as the [store kit](../store-kit/README.md) writes them |
| `gives` | what the Operation gives, in the display form, after the Core's conversion; Nothing if absent |
| `error` | the error the Operation fails with, as a display-form map of its `code` and fields, without `message` |
| `status` | a hook's status; `ok` if absent |

Foreign keys are on, in the setup and in the implementation, since chapter 7's `foreign key` constraints and deferred constraints need SQLite to enforce them.

A step has either `hook` or `do`. A Segment's `begin` hook comes before its first Segment-bound Operation, as the Core arranges, and every hook sees every Grant the Segment has enrolled, as [the lifecycle contract](../../spec/embedding/scoped-effects.md#segment-participant) gives them. A read may come from a Segment that hasn't begun.

A runner calls the implementation as the `sqlite` factory would: it converts `params` by chapter 7's rules, and converts the answer to the value a Script would see, so `gives` and `error` are what a Script sees. A step whose `error` the Core raises itself, such as `wrong kind` or `unrepresentable` for a `REAL`, holds the implementation and the Core together to the value mapping. A runner may run those steps through the factory, or through the same conversions.

- **`sql` errors:** `reason` is SQLite's text or the Host's own, which isn't portable, so a kit `error` of `{code: "sql"}` matches any `sql` failure whose `reason` is text.
- **`{store}`:** in a `sql` text or a `tables` list, the runner puts the name of the table that keeps the co-located Store.
- **Interleaving** stands for preemption: a Segment's steps between another Segment's are what a preempted Run's Segment does while it holds the database's write lock.
- **Nothing ran:** a failed step leaves the database as it was, which later reads check.

## Files

| File | Holds an implementation to |
| --- | --- |
| [`values.toml`](values.toml) | the value mapping in both directions, with its refusals, and rows in column order |
| [`statements.toml`](statements.toml) | one statement per call, and bound parameters with their mismatches |
| [`authorizer.toml`](authorizer.toml) | the authorizer's denials, its allowed `PRAGMA`s and a binding's `tables` |
| [`queries.toml`](queries.toml) | `query`'s read-only check, and `change`'s answers |
| [`rows.toml`](rows.toml) | `max`, `too many rows`, atomic calls and constraints |
| [`segments.toml`](segments.toml) | the Segment's transaction, Script transactions as savepoints, and deferred constraints at commit |
| [`contention.toml`](contention.toml) | `sqlite busy` under a preempted writer, and reads that see committed state or the Segment's own writes |
| [`store.toml`](store.toml) | a Store sharing the database's coordinator: one commit for both, `store busy`, and the Store's table denied to `sqlite` |
