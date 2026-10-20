# TS Host functions take the JS forms of their Shapes

A TS Capability's Host functions (`do`, `run`, `start`, `fire`) take each argument in the JS form of its declared Shape, and may return the result Shape's JS form. TypeScript infers the types from the Operation's literal `args` and `result`, so a callback for `args: [shape.text]` takes a `string` and needs no `asText()!`. The Core already checks every argument before the Host function runs, so the conversion can't fail, and the `!` and the guide's explanation of why it is safe both go. A JS result goes through the named constructors before the Core's result check, so ADR 0030's refusals still apply: a JS form the Shape doesn't name fails as any wrong result does. The change replaces the `Value` form outright rather than adding an opt-in, so a TS Host has a single way to write an Operation.

## Considered Options

- **Opt-in typed callbacks** (a flag, or an `operation()` helper): no break, but two ways to write every Operation, and the untyped form keeps needing the explanation.
- **Static narrowing only** (a branded `Value<'text'>` whose `asText()` returns `string`): no runtime change, but callbacks still read through accessors and build results with constructors.
- **Plain forms for composite Shapes** (`listOf(text)` as `string[]`, maps as objects): more convenient, but nested conversion brings back the choices ADR 0119 makes with options (map order, number form). Composite Shapes stay `Value`s; a Host can call `fromValue` when it wants that.
- **`defineCapability<Db>(name, ops)` with an explicit binding type:** TypeScript can't infer some type arguments while the caller names others, so naming `Db` would turn off the per-Operation inference. The binding type is named by currying instead: `defineCapability<Db>()(name, ops)`.

## Consequences

- Breaks every TS Host that defines a Capability. A scalar-Shaped argument is no longer a `Value`, and an explicit binding type needs the curried call.
- Argument forms: text `string`; boolean `boolean`; number `Decimal`; Bytes a copied `Uint8Array`; Instant `bigint` epoch microseconds; Nothing `null`; a Host Object its `HostObject` handle; an Optional Shape its inner form, `null` for a supplied Nothing, and absent when omitted. Every other Shape (`any`, `value`, lists, maps, `oneOf`, Quantities, Civil Dates, ranges, Text Patterns, Function Values) gives the `Value`.
- A result, and `call.answer`'s argument, may be the result Shape's JS form, a `bigint` for a number, `undefined` for Nothing or an Optional Shape, or any `Value`.
- `Shape` carries its JS form as a compile-time type parameter. An Operation whose Shapes were built at run time as `Shape[]` types its arguments `unknown`, though scalar Shapes still arrive in their JS forms.
- A `run` answer settles one microtask after its Promise, because the result is converted first.
- The Core's own Capabilities and the corpus runner's Stubs keep the `Value` form through an internal definer. Go Hosts are unchanged.
- The declarations are in `spec/embedding/talk.ts`, and chapter 9 states the rule under Shapes.

This ADR records the design from [#1420](https://github.com/odogono/odgn-talk/issues/1420).
