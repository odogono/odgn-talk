# The store test kit

Operation and lifecycle sequences that every `store` implementation must follow ([chapter 7](../../spec/07-libraries-and-the-standard-library.md#store), [ADR 0050](../../docs/adr/0050-the-store-is-a-standard-capability-with-segment-bound-writes.md), [ADR 0062](../../docs/adr/0062-a-store-key-is-reserved-while-a-segment-holds-an-uncommitted-write.md)). Trace Cases cover the Core's side of `store` through Stubs. The Store itself is the Host's, so this kit holds each Store to the Spec instead. It is language-neutral data, so every Core's Hosts can reuse it.

These aren't Trace Cases, and the corpus runners skip this directory.

## Format

Each `.toml` file sets default `quotas`, `{size, keys, value}`, and lists `[[sequence]]` tables. Each sequence has a `name`, optional `quotas` of its own, and `steps`. A runner builds a fresh Store with the sequence's quotas, then runs the steps in order:

| Key | Is |
| --- | --- |
| `in` | the Segment the step belongs to, as its Segment id |
| `do` | `begin`, `commit` or `rollback`, a lifecycle hook; or `get`, `set`, `delete`, `keys`, `increment` or `swap`, an Operation |
| `store` | the Grant's binding, the Store's name; `default` if absent |
| `args` | an Operation's arguments as supplied, as a display-form list; an omitted Optional argument is left off |
| `gives` | what the Operation gives, in the display form; Nothing if absent |
| `error` | the error the Operation fails with, as a display-form map of its `code` and fields, without `message` |
| `status` | a lifecycle hook's status; `ok` if absent |

The Core has already checked each call's Shapes and refused an empty key, so the kit never gives a Store either. A step's Segment begins before its first write, as the Core arranges. A read may come from a Segment that hasn't begun.

## Running

- **TS:** [`impl/ts/tools/store-kit.ts`](../../impl/ts/tools/store-kit.ts) drives any `StoreImpl` through the kit. [`impl/ts/tests/store-kit.test.ts`](../../impl/ts/tests/store-kit.test.ts) runs it on the memory and Web Storage Stores, and [the SQLite Store's tests](../../impl/ts/examples/store-sqlite/) on that Store.
