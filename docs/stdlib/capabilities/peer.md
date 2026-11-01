# peer

<!-- Generated from spec/data/stdlib.toml by tools/spec/generate.ts. Edit those, then run `bun run spec:gen`. -->

`peer` is a Standard Capability: a Script calls its Operations through a Grant the Host gives it, with `ask` for an answer or `tell` for none, and a suspending one with `and wait`. A call the Grants don't allow fails to load. The full rules: [chapter 7](../../../spec/07-libraries-and-the-standard-library.md#peer). Arguments are checked against the Operation's Shapes, and a mismatch raises `wrong kind`; the entries below list the other errors.

> **Optional:** a Host may choose not to offer `peer`.

### expose

`expose [name]`, suspending

A Peer to the calling Script, once it is an Exposed Script: reachable from other Groups by the text `name` through this Grant, or without `name` through a new unnamed exposure only that Peer reaches.

Errors: [`bad address`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`name in use`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### unexpose

`unexpose exposure`, immediate

Nothing; withdraws the Script's exposure through this Grant that `exposure` names, as the text name of a named one or the Peer `expose` gave, if there is one.

Errors: [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### reach

`reach address`, suspending

A Peer: a Host Object of kind `peer` standing for the Exposed Script the text `address` names.

Errors: [`bad address`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`not exposed`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### post

`post peer, message, args`, fire-and-forget

Sends the message `message` with the list `args` to the Peer `peer`'s Exposed Script, at most once; a plain `send` to a Peer is this.

Errors: [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`wrong kind`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`bad message name`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`not encodable`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### call

`call peer, message, args`, suspending

The reply of the Peer `peer`'s Exposed Script to the message `message` with the list `args`, sent at most once; `send … and wait` to a Peer is this.

Errors: [`send failed`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`wrong kind`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`bad message name`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`not encodable`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### caller

`caller`, immediate

The Caller Identity of the Remote Send that started the calling Run: the data the receiving Host vouches for about who made it, or Nothing.
