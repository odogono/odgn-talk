# timer

<!-- Generated from spec/data/stdlib.toml by tools/spec/generate.ts. Edit those, then run `bun run spec:gen`. -->

`timer` is a Standard Capability: a Script calls its Operations through a Grant the Host gives it, with `ask` for an answer or `tell` for none, and a suspending one with `and wait`. A call the Grants don't allow fails to load. The full rules: [chapter 7](../../../spec/07-libraries-and-the-standard-library.md#timer). Arguments are checked against the Operation's Shapes, and a mismatch raises `wrong kind`; the entries below list the other errors.

### schedule

`schedule name, at, message, args`, fire-and-forget

Stores a durable timer that delivers `message` with the list `args` to the Script at the Instant `at`, replacing one of the same name.

### cancel

`cancel name`, fire-and-forget

Removes the Script's timer called `name`, if there is one.
