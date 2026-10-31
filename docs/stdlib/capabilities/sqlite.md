# sqlite

<!-- Generated from spec/data/stdlib.toml by tools/spec/generate.ts. Edit those, then run `bun run spec:gen`. -->

`sqlite` is a Standard Capability: a Script calls its Operations through a Grant the Host gives it, with `ask` for an answer or `tell` for none, and a suspending one with `and wait`. A call the Grants don't allow fails to load. The full rules: [chapter 7](../../../spec/07-libraries-and-the-standard-library.md#sqlite). Arguments are checked against the Operation's Shapes, and a mismatch raises `wrong kind`; the entries below list the other errors.

> **Optional:** a Host may choose not to offer `sqlite`.

### query

`query sql, params [, max]`, immediate

The rows the read-only statement `sql` gives with `params` bound, as a list of maps from column name to value, in column order.

Errors: [`sql`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`not read-only`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`too many rows`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`unrepresentable`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`out of range`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### change

`change sql, params [, max]`, immediate

The map `{changes, rows}`: the rows the statement `sql` changed, and the rows it gave, such as those of a `RETURNING` clause; it commits with the Segment.

Errors: [`sql`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`constraint`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`sqlite busy`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`too many rows`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`unrepresentable`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`out of range`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### begin

`begin`, immediate

Nothing; opens the scope `transaction`, which `rollback` abandons.

Errors: [`sqlite busy`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`scope already open`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`scope in join`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### commit

`commit`, immediate

Nothing; closes the scope `transaction`, keeping its changes until the Segment commits.

Errors: [`scope not open`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### rollback

`rollback`, immediate

Nothing; closes the scope `transaction`, discarding its changes.

Errors: [`scope not open`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).
