# peer

<!-- Generated from spec/data/stdlib.toml by tools/spec/generate.ts. Edit those, then run `bun run spec:gen`. -->

`peer` is a Standard Capability: a Script calls its Operations through a Grant the Host gives it, with `ask` for an answer or `tell` for none, and a suspending one with `and wait`. A call the Grants don't allow fails to load. The full rules: [chapter 7](../../../spec/07-libraries-and-the-standard-library.md#peer). Arguments are checked against the Operation's Shapes, and a mismatch raises `wrong kind`; the entries below list the other errors.

> **Optional:** a Host may choose not to offer `peer`.

### expose

`expose name`, suspending

Nothing, once the Script is an Exposed Script reachable from other Groups by the text `name` through this Grant.

Errors: [`bad address`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`name in use`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### unexpose

`unexpose name`, immediate

Nothing; withdraws the Script's exposure called `name` through this Grant, if there is one.

Errors: [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### reach

`reach address`, suspending

A Peer: a Host Object of kind `peer` standing for the Exposed Script the text `address` names.

Errors: [`bad address`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`unreachable`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### post

`post peer, message, args`, fire-and-forget

Sends the message `message` with the list `args` to the Peer `peer`'s Exposed Script, at most once; a plain `send` to a Peer is this.

Errors: [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`wrong kind`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`bad message name`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`not encodable`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### call

`call peer, message, args`, suspending

The reply of the Peer `peer`'s Exposed Script to the message `message` with the list `args`, sent at most once; `send … and wait` to a Peer is this.

Errors: [`send failed`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`wrong kind`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`bad message name`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`not encodable`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).
