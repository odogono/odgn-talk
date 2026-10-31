# calendar

<!-- Generated from spec/data/stdlib.toml by tools/spec/generate.ts. Edit those, then run `bun run spec:gen`. -->

`calendar` is a Standard Capability: a Script calls its Operations through a Grant the Host gives it, with `ask` for an answer or `tell` for none, and a suspending one with `and wait`. A call the Grants don't allow fails to load. The full rules: [chapter 7](../../../spec/07-libraries-and-the-standard-library.md#calendar). Arguments are checked against the Operation's Shapes, and a mismatch raises `wrong kind`; the entries below list the other errors.

### today

`today [zone]`, immediate

The date-only Civil Date in the zone at the Pump's Clock reading.

Errors: [`unknown zone`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### now

`now [zone]`, immediate

The date-time in the zone at the Pump's Clock reading.

Errors: [`unknown zone`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### toCivil

`toCivil i [, zone]`, immediate

The date-time in the zone at the Instant `i`.

Errors: [`unknown zone`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### toInstant

`toInstant c [, disambiguation] [, zone]`, immediate

The Instant at which the zone's wall clock reads the date-time `c`.

Errors: [`unknown zone`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`ambiguous time`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### offset

`offset i [, zone]`, immediate

The zone's offset from UTC at the Instant `i`, as an exact duration.

Errors: [`unknown zone`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### zone

`zone [zone]`, immediate

The IANA id of the zone in use.

Errors: [`unknown zone`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).
