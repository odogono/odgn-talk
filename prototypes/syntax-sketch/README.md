# PROTOTYPE: syntax sketch (throwaway)

Rough example Scripts for [Syntax sketch: what scripts look like](https://github.com/odogono/odgn-talk/issues/13).
Nothing here parses or runs; there is no grammar yet. The files are for reacting to.

- `-- ALT:` marks a competing spelling of the line above it.
- `-- ??` marks something that felt wrong or ambiguous while writing it.
- `-- [advanced]` marks something meant for the advanced layer only.

Read in order:

| File | Covers |
| --- | --- |
| `01-beginner-basics.talk` | variables, `put`/`let`, lists and maps, loops, functions, `&`, `as number` |
| `02-numbers-units-time.talk` | Quantities, compound units, ranges, Instants, Civil Dates, rounding, "could it convert", `is nothing` vs `is empty` |
| `03-chunks-and-text.talk` | Chunk reads and writes, padding, `character -1`, `delimited by`, `ignoring case`, `code point` |
| `04-handlers-and-clauses.talk` | Handler Clauses, Guards, Destructuring, pin, `pass` |
| `05-text-patterns.talk` | `match`/`when`, `when contains`, typed captures, `replace`, Pattern values, `the match of` |
| `06-async-and-events.talk` | `send`, `send … and wait`, queueing modifiers, `wait for … or`, `veto` |
| `07-host-and-capabilities.talk` | Host Objects, Capabilities, suspending calls |
| `08-invoice-server.talk` | a realistic multi-tenant server Script |
| `09-http-fetch.talk` | fetch JSON over HTTP, validate its shape, filter/map/sort it, paging, several fetches at once |
| `10-binary-patterns.talk` | Elixir-style binary matching and building on bytes |
| `NOTES.md` | what felt right, what felt wrong, open questions |
