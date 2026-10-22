# `http` is an optional Standard Capability answered by the Run that receives each HTTP Exchange

A Script should be able to serve HTTP itself, so that one file both starts a server and answers its HTTP requests, the way a Node file does. Until now only Host code served HTTP: the webhooks and tenants Example Hosts own the listener and turn each HTTP request into a `Request`. `http` becomes an optional Standard Capability, like `sqlite` and `user` (ADR 0070, ADR 0077). Its server Operations copy the `store` watch (ADR 0061):

```
on start args
  ask http to serve "site", "/", "httpRequest", {port: 3000} and wait
end start

on httpRequest {method: "GET", segments: ["users", id], exchange: x}
  ask http to respond x, {json: {id: id}}
end httpRequest
```

- `serve name, prefix [, message [, options]]` makes a Serve Registration. It is suspending and gives `{host, port}` once the listener is listening, so a bind failure is the Script's error and `port: 0` reports the port it got.
- `unserve name` removes it.
- Each HTTP request whose path the registration's prefix matches, the longest prefix winning, is an HTTP Exchange. It arrives as an ordinary Delivery of the registration's message, so routing within a Script is Handler Clause dispatch.
- `respond exchange, response` answers it. Only the Run that Delivery started may respond.

## Considered Options

- **The Handler's `return` is the response,** as for `Request` and the Example Hosts. It is shorter and can't be forgotten. But the Run can't answer first and keep working, and a Handler that returns for its own callers can't also choose what the client sees. A handle answered once makes the response an effect like any other.
- **A handle any Run may answer, until a timeout gives 504:** this allows handing an exchange to a worker. But a forgotten response then hangs until the deadline, and two Runs could race to answer it. Tying it to the receiving Run fails fast with 500 when that Run ends unanswered. A long poll still works with `wait for` inside the same Run.
- **Ownership by the receiving Script:** this needs no Core change, since a Host function already sees the calling Script. But it lets one Run answer another's exchange by accident. ADR 0125 gives the Host the delivery that started the calling Run, which is enough to check the Run.
- **A Capability Scope per exchange:** a Scope blocks suspending calls and Joins while it is open (chapter 7), so a Handler couldn't wait for anything before responding.
- **A route table in the Script (`route "GET /users/:id", "showUser"`):** this is familiar from web frameworks, but it duplicates what Handler Clauses and their patterns already do.
- **The Host decoding bodies by content type:** convenient, but an implicit conversion (ADR 0003). A request's `body` is always Bytes, and the Script decodes it with `bytes` or `json`. A response may give text, Bytes, or `json:`, a value the Host serialises by the stdlib `json` rules.
- **Only the binding names the address:** the Grant binding decides which addresses are allowed, as a binding holds a Store's or a URL's real identity. But a Node-style Script expects to name its port. So the Script may ask for `{host, port}`, and the binding allows or refuses it with `bad address`. The Script Runner allows any (ADR 0126).
- **The name `http`:** the glossary already uses `http` as its example Capability for outbound calls. One name holds server Operations now and client Operations such as `fetch` later, and a Grant can be limited to either set.

## Consequences

- **Optional:** a Host need not offer `http`. A Host that offers it follows every rule in chapter 7, and every Core defines its Operation Declarations and checks.
- **Registrations** follow the watch rules: they are identified by Group, Script, named Grant and name. Re-serving the same parameters does nothing, and serving different ones replaces the registration. `invalid serve` checks `name`, `prefix` and `message`. Registrations on one host and port share a listener, which closes with its last registration.
- **The Delivery's argument** is `{method, path, segments, query, headers, body, exchange}`:
  - header names are lowercase, and repeated headers are joined, except `set-cookie`, which is a list;
  - `query` maps text to text, and a repeated key gives a list;
  - `segments` is the path split on `/`, percent-decoded, without empty parts;
  - `exchange` is a Host Object with a read-only `closed`.
- **Statuses the Host answers itself:**
  - no matching registration, or the Run ends `unhandled`: 404;
  - an uncaught error, a Limit Fault, or the owning Run ending without a response: 500, with the error logged and never sent to the client;
  - a full mailbox, a cancelled or dropped Run, or a stopping Group: 503.
- **A client disconnect** closes the exchange, and a later `respond` raises `exchange closed`. It doesn't cancel the Run, so the Run's writes still commit.
- **Saving:** a Group with an open exchange isn't saved. After a restore, an exchange is gone.
- **Errors:** `address in use`, `bad address`, `already responded`, `exchange closed` and `not owner`, which the Host fails with, and `invalid serve` and `invalid response`, which the Core raises.
- **Not in v1:** streaming bodies, WebSockets and server-sent events, TLS (a proxy's job), and handing an exchange to another Run.
