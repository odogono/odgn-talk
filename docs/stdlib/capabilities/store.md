# store

<!-- Generated from spec/data/stdlib.toml by tools/spec/generate.ts. Edit those, then run `bun run spec:gen`. -->

`store` is a Standard Capability: a Script calls its Operations through a Grant the Host gives it, with `ask` for an answer or `tell` for none, and a suspending one with `and wait`. A call the Grants don't allow fails to load. The full rules: [chapter 7](../../../spec/07-libraries-and-the-standard-library.md#store). Arguments are checked against the Operation's Shapes, and a mismatch raises `wrong kind`; the entries below list the other errors.

### get

`get key [, default]`, immediate

The value under `key`, as the Segment sees the Store, or else `default`, or Nothing.

Errors: [`invalid key`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### set

`set key, value`, immediate

Nothing; puts `value` under `key` when the Segment commits, and Nothing deletes the key.

Errors: [`invalid key`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`can't store`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`store full`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`store busy`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### delete

`delete key`, immediate

Nothing; removes `key` when the Segment commits, if it is there.

Errors: [`invalid key`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`store busy`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### keys

`keys [prefix]`, immediate

The keys the Segment sees that begin with `prefix`, in Unicode code-point order.

### increment

`increment key [, by]`, immediate

The key's value as the Segment sees it after adding `by`, 1 by default; commit adds `by` to the value committed then.

Errors: [`invalid key`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`wrong kind`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`incompatible units`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`overflow`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`store full`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`store busy`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### swap

`swap key, expected, new`, immediate

`true`, after putting `new` under `key`, if the Segment sees `expected` there, and `false` otherwise.

Errors: [`invalid key`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`can't store`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`store full`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`store busy`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### watch

`watch name, prefix [, message]`, immediate

Nothing; from now on, each commit that changes keys beginning with `prefix` delivers `message` to the Script, replacing its watch called `name`.

Errors: [`invalid watch`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`watch limit`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### unwatch

`unwatch name`, immediate

Nothing; removes the Script's watch called `name` through this Grant, if there is one.

Errors: [`invalid watch`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).
