# SQLite Store

A `store` implementation ([chapter 7](../../../../spec/07-libraries-and-the-standard-library.md#store)) for server Hosts, on `bun:sqlite`. From the repository root, using Bun 1.4.2:

```sh
bun install
bun impl/ts/examples/store-sqlite/main.ts /tmp/counter.sqlite
bun test impl/ts/examples/store-sqlite
```

`main.ts` loads [`count.talk`](count.talk), which counts its own runs in the Store named `visits`, so each run of the command prints the next count.

## How it keeps a Store

[`store.ts`](store.ts) is a backend for the TS Core's Store engine, [`Stores`](../../src/store/engine.ts). The engine holds each Store's committed contents in memory, with every live Segment's pending writes, the key reservations of [ADR 0062](../../../../docs/adr/0062-a-store-key-is-reserved-while-a-segment-holds-an-uncommitted-write.md) and the quota checks. The backend reads a Store's rows once, when the Store is first used, and applies each commit's changes in one SQLite transaction. The engine is one Segment Coordinator for every Store it keeps ([ADR 0069](../../../../docs/adr/0069-segment-bound-grants-share-a-participant-through-a-segment-coordinator.md)), so a Segment that writes several Stores commits them all in that one transaction. A commit that SQLite refuses reports `failed`, and neither the database nor the engine's copy of any Store changes.

- **Rows:** one table, `store`, keyed by the Store's name and the key, with each value in [the Value Encoding](../../../../spec/09-embedding.md#json-and-the-value-encoding).
- **One process:** reservations live in the process that holds the engine, so the database file must have no other writer. `openSqliteStores` takes SQLite's exclusive lock when it opens the file and holds it until `close`, so a second process, or a second connection, can't open it.
- **Quotas** are the Host's: `main.ts` uses the Session Store's.
- **Durability** is SQLite's, in WAL mode with its default synchronous setting.

The [store test kit](../../../../corpus/store-kit/) runs against this Store in [`store.test.ts`](store.test.ts).
