# http

<!-- Generated from spec/data/stdlib.toml by tools/spec/generate.ts. Edit those, then run `bun run spec:gen`. -->

`http` is a Standard Capability: a Script calls its Operations through a Grant the Host gives it, with `ask` for an answer or `tell` for none, and a suspending one with `and wait`. A call the Grants don't allow fails to load. The full rules: [chapter 7](../../../spec/07-libraries-and-the-standard-library.md#http). Arguments are checked against the Operation's Shapes, and a mismatch raises `wrong kind`; the entries below list the other errors.

> **Optional:** a Host may choose not to offer `http`.

### serve

`serve name, prefix [, message [, options]]`, suspending

`{host, port}` once the Host listens; from then on, each HTTP request whose path the text `prefix` begins delivers `message` to the Script, replacing its Serve Registration called `name`.

Errors: [`invalid serve`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`address in use`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`bad address`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### unserve

`unserve name`, immediate

Nothing; removes the Script's Serve Registration called `name` through this Grant, if there is one.

Errors: [`invalid serve`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### respond

`respond exchange, response`, immediate

Nothing; answers the HTTP Exchange `exchange` with the map `response`'s `status`, `headers` and `body` or `json`.

Errors: [`invalid response`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`already responded`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`exchange closed`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`not owner`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).

### fetch

`fetch url [, request]`, suspending

`{status, headers, body}`: the final response to one HTTP request for the absolute URL `url`, made with the map `request`'s `method`, `headers`, `query` and `body` or `json`, with `body` always Bytes.

Errors: [`invalid request`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`bad address`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`network error`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`response too large`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue), [`out of domain`](../../../spec/06-errors-and-limits.md#the-error-code-catalogue).
