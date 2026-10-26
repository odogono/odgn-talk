# TS Helpers convert plain JS at the boundary

A small set of TS Helpers lets a Host embed a Script without handling `Value`s or wiring a driver: `createGroup({ name, core? })` returns a driven Group that closes with `await using`; `script.handlers.<name>(...args)` sends a Request to that Handler; and `inlineGrants({ cap: { op: fn } })` defines one Capability per key and grants all its Operations. They convert arguments with `toValue` and results with `fromValue` (ADR 0119), so the table there stays the single rule for plain JS data. The Helpers differ from that table in one place: they pass `toValue` the new option `numbers: 'integer'`, which accepts a JS `number` that is a safe integer and refuses any other. `handlers.total(2, 3)` therefore works, while `handlers.total(0.1, 3)` throws and names `dec()` or `{ numbers: 'decimal' }`. A safe integer is exact, so ADR 0119's reason for refusing `number` (a value `JSON.parse` has already rounded) doesn't apply to it. `toValue`'s own default stays `'refuse'`.

The Helpers are built only on the shared `Core`, `Group` and `Script` interfaces (ADR 0121), as the driver is, so they run unchanged over the TS Core and the Zig Host Adapter, and `talk.ts`'s interfaces gain no members.

## Considered Options

- **Members on `Group` and `Script`** (`script.handlers`, `group.close`): reads the same, but every Core would implement them, and they add no behaviour the interface doesn't already allow.
- **New conversion rules for the Helpers** (`Date` as an Instant, `undefined` refused): a second table for the same boundary, differing from ADR 0119's in ways a Host would trip over.
- **`numbers: 'decimal'` as the Helpers' default:** convenient, but a float from `JSON.parse` would silently become a Decimal, which ADR 0119 rejects.
- **Ambient Host functions** (`sum(10, 10)` without a Grant): breaks the Grant model. A granted Operation can already be written as a Host Command, `sum 10, 10`.
- **Detecting `async` functions in `inlineGrants`:** unreliable across transpilers, so a suspending Operation is marked `{ async: fn }`.

## Consequences

- `toValue`'s `numbers` option gains `'integer'`; the declaration in `spec/embedding/talk.ts` and ADR 0119's table note it.
- `handlers` results, and `inlineGrants` arguments, take `fromValue`'s default form: a number is a `Decimal`, a map a plain object, and Instants, Quantities and other kinds without a JS form stay `Value`s. `inlineGrants` Operations take `value` Shapes, so they don't get ADR 0120's per-Shape scalar forms; a Host that wants those uses `defineCapability`.
- `inlineGrants` Operations cost no Fuel beyond the call's instructions, are immediate unless marked `{ async: fn }`, take their argument count from `fn.length` unless given `arity`, and use no Argument Labels. They are marked `command`, so a Script may write `sum 10, 10` (or `fetch id and wait` for a suspending one), and the usual Host Command load errors apply to a Reserved Word name or a clash between Grants.
- `handlers` is untyped by default. `group.load<T>()` lets the Host state a type for it, which nothing checks.
- `script.invoke` still takes and returns `Value`s.
- Chapter 9 lists the Helpers beside the driver, and the TS embedding guide leads with them.
