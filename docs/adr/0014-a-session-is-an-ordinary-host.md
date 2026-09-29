# A REPL or Playground session is an ordinary Host running an ordinary Script Group

The core has no session concept. A REPL or Playground session is a Host holding one Script Group of named Session Scripts (one, `session`, to start with). Each Entry's definitions are added to the current Script, and its statements run as a Run of an implicit Handler. A name first assigned at the prompt becomes an implicit Script Variable, so a session means exactly what its `:export` means as a file, and Segment rollback on a Limit Fault covers prompt state with no extra rule. Defining something new uses a general embedding-API operation, *extend Script*, which adds Handlers, functions and Script Variables without touching existing code, so suspended Runs survive. Replacing an existing definition is still stop-and-reload (ADR 0005), with Script Variables carried over and the discarded Runs reported. The shared REPL design, including its Session Commands and the display form of echoed values, is normative: a Session Transcript is a Conformance Corpus case kind that must replay identically on the Go REPL and the TS REPL. We chose this because a session concept in the core would add spec surface that both Cores must match bit-for-bit, only to serve tooling. Every gap a session exposes (incremental loading, inspection, save) turned out to be a general Host need. And the REPL is the first thing built, so its transcripts are the first real parity test.

## Considered Options

- **A Session as a new core kind next to Script and Run:** its own scope, redefinition and limit rules, all of which both Cores would have to match.
- **A separate prompt scope held by the REPL Host:** handlers can't see prompt locals, a suspended Entry writes back late (last to finish wins), and it adds a scope no Script has.
- **Always stop-and-reload on any definition:** defining a new Handler would discard unrelated suspended Runs.
- **Old Runs keep running on old code** (Erlang-style two versions): a new core feature, and it complicates Script Snapshots.
- **Transcripts as a REPL convenience only:** leaves the first-built Host outside the parity check, and the display form unspecified.

## Consequences

- An Entry is atomic at load: any load-time error rejects the whole Entry, and none of its definitions apply. An `on m` Entry replaces all existing clauses of `m`. Re-entering `script variable x = …` resets `x`.
- The prompt stays in the foreground until the Entry's Run ends, except under a virtual Clock, where a deadline wait returns the prompt at once. Background Runs report their output, and their final value, labelled by Run.
- A bare expression is accepted only at the prompt, and it echoes in the normative display form (which distinguishes `"5"` from `5`).
- A session uses the spec's default limit profile. `:limits` affects only Runs started afterwards, and Ctrl-C is the ordinary cancel-Run.
- A bare session grants only `console` (write, immediate; read, suspending). Mock Capabilities, and any real ones the REPL Host has built in, are added with `:grant`. The Clock is real by default, or virtual under `:clock virtual`.
- `:runs`, `:mailbox` and `:vars` render a same-core Script Snapshot (ADR 0008) taken at a Quiescent moment. `:save`/`:restore` wrap the same-core save. Playground sharing is source-only: a Session Transcript or an exported Script.
- A message reaching the end of a session's flat Message Path is reported, not an error.
- Narrowed by ADR 0018: the display form must round-trip, since corpus cases write every value in it. A Session Transcript is a readable `.transcript` file with a blessed Trace beside it.
- Narrowed by ADR 0019: `say x` is sugar for `tell console to write x`. At the prompt, an Entry is decided on its first token. A word that isn't reserved starts a Command Call only if the Session Script has a Handler by that name. Otherwise the Entry is an expression, and its value is echoed.
- Narrowed by ADR 0020: an Entry that starts with `use` or `constant` followed by a name is a declaration, like `script variable`, applied by *extend Script*. The stdlib Libraries are always registered. User Libraries come in with `:library add name path` at the REPL, or a Library tab in the Playground, where saving does `replaceLibrary`. A Session Transcript records each `add library` with its source, and `:export` writes the `use` lines and each user Library as its own file.
- Narrowed by ADR 0028: the Playground ships the LSP in a worker, the formatter, and live and replay debugging. A shared link carries the source and, optionally, a Session Transcript, which replays on opening. The Go REPL has no Lints, formatter or debugger.
