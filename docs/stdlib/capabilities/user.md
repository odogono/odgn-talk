# user

<!-- Generated from spec/data/stdlib.toml by tools/spec/generate.ts. Edit those, then run `bun run spec:gen`. -->

`user` is a Standard Capability: a Script calls its Operations through a Grant the Host gives it, with `ask` for an answer or `tell` for none, and a suspending one with `and wait`. A call the Grants don't allow fails to load. The full rules: [chapter 7](../../../spec/07-libraries-and-the-standard-library.md#user). Arguments are checked against the Operation's Shapes, and a mismatch raises `wrong kind`; the entries below list the other errors.

> **Optional:** a Host may choose not to offer `user`.

### confirm

`confirm message`, suspending

`true` when the person accepts the question `message`, and `false` when they decline or dismiss it.

Errors: [`user busy`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### choose

`choose items [, options]`, suspending

The item of the list of texts `items` the person chose, or with `multiple: true` a list of those they chose, in list order; Nothing if they cancel.

Errors: [`user busy`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### enter

`enter message [, options]`, suspending

The text the person entered for `message`, starting from `options`' `default`; Nothing if they cancel.

Errors: [`user busy`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### notify

`notify message [, options]`, fire-and-forget

Shows `message`, with `options`' `title`, without waiting for anyone.
