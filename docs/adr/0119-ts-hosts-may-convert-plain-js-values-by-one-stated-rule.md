# TS Hosts may convert plain JS values by one stated rule

The TS embedding API adds `toValue(plain, options?)` and `fromValue(value, options?)`. They convert between Script Values and plain JS data in one call, so a Host no longer wraps each argument in a constructor and reads each result with `asDecimal()!`. Both are thin layers over the named constructors and accessors, and follow a fixed table, so ADR 0030's guarantees still hold: every conversion follows a spec rule, input the value model can't hold is refused with `invalid value`, and nothing is clamped, rounded or replaced. Only JS `number` is ambiguous. `toValue` refuses it unless the Host passes `{ numbers: 'decimal' }`, which applies `num`'s shortest round-trip rule. A JSON-shaped float therefore never becomes a decimal unless the Host asks for it. We chose this over throwing accessors (`expectText()`) alone because these accessors remove the `!` but still need one call per field. A Host with nested data would end up writing this conversion itself, and each Host's version would differ.

## Considered Options

- **Throwing accessors only** (`expectText()`, `expectDecimal()`): smaller, but they don't help with input or with nested data.
- **Accepting `number` by default:** a Host that reads JSON with `JSON.parse` has already rounded the value. Accepting it silently hides that, which ADR 0030 exists to prevent.
- **`value.toJs()` as a method:** it would put plain-data rules on the opaque `Value`. A free function keeps `Value`'s declaration unchanged.
- **The same functions in Go:** Go's native types bring the ambiguities ADR 0030 lists (map order, `float64`, `any`), and Go has no single plain-data shape like JS's. It can follow separately if needed.

## Consequences

- Narrows ADR 0030. `toValue` and `fromValue` accept native JS types, but only those in the tables below, and only in TS.
- `toValue` reads:
  - a `Value` unchanged, so a Host can mix plain data and built Values
  - `null` and `undefined` as Nothing (the named constructors still refuse them)
  - a boolean, a string (refused if it has a lone surrogate, normalised to NFC), a `bigint`, a `Decimal`, and a `Uint8Array` (copied)
  - a `number` only with `{ numbers: 'decimal' }`, through `num`
  - an array as a list, with holes read as Nothing
  - a plain object, by `record`'s rules (integer-like keys refused), and a `Map` with text keys, by `map`'s rules
  - Anything else is refused: `Date`, functions, symbols, class instances, other typed arrays, and cyclic data.
- `fromValue` writes:
  - Nothing as `null`
  - booleans, text and Bytes (copied) as their JS forms
  - a number as a `Decimal`, or as its canonical text with `{ numbers: 'string' }`
  - a list as an array
  - a map as a plain object, or as a `Map` in insertion order with `{ maps: 'map' }`. Objects write keys with `defineProperty`, so `__proto__` stays an ordinary key, but JS moves integer-like keys first.
  - Every other kind (Quantity, Civil Date, Instant, range, Text Pattern, Function Value, Host Object) as the `Value` itself.
- `toValue(fromValue(v))` equals `v` for every `v`, except a map with an integer-like key written as a plain object, which `toValue` refuses. With `{ maps: 'map' }` the round trip always holds.
- The declarations are in `spec/embedding/talk.ts`, and chapter 9 lists them under Values at the boundary.

This ADR records the design from [#1419](https://github.com/odogono/odgn-talk/issues/1419).
