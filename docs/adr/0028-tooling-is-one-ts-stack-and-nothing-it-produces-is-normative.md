# Tooling is one TS stack over the TS Core, and nothing it produces is normative

The LSP, the formatter, the debugger and the Lint engine (ADR 0027) are one TypeScript tooling stack. It runs under Bun or Node for desktop editors and in a browser worker for the Playground, and it is built on the TS Core's own parser and checker. That parser produces a lossless syntax tree, comments and blank lines included, and recovers after the first error, which ADR 0019 already leaves to the Cores and tooling. There is no Go tooling beyond the Go REPL: Go users edit with the same LSP, and a Script in a Go Host is debugged by replaying its Trace on the TS Core. Nothing the tooling produces is normative. The pieces it rests on already are: the first syntax error, the checker diagnostics, the display form, the source map, the lowering and Session Transcripts. The formatter's layout, the LSP's features and the debugger's behaviour are tooling freedom. Tooling learns what a Host offers from a **Host Manifest**, a data file the Host exports for each kind of Script. A debugger pauses a whole Script Group at an instruction boundary. The pause is not a Host Input, so debugging never changes what a Script does. We chose this because, as with Lints, output that never changes behaviour gives parity nothing to protect. `gofmt` has one canonical format because it has one implementation, not because a spec pins it. Sharing the Core's parser means tooling can never disagree with the Core about what parses or where the first error is, and the corpus's diagnostic cases already pin that parser. A separate tooling parser would be a third implementation of the grammar that parity doesn't check. Parity is also what makes replay debugging possible: a Trace replays on its own on any Core (ADR 0018), so a Go Host needs no debugger of its own.

## Considered Options

- **A normative formatter, pinned by corpus cases:** one canonical layout across every implementation, but there is only one implementation, and every layout change would be a language change.
- **A normative debugger protocol:** it constrains both Cores to serve a tool that only the TS side runs.
- **A separate tooling parser** (tree-sitter, with incremental reparsing): fast editor highlighting, but a third grammar that can drift from the Cores unchecked. It can be added later as a non-normative extra for editors that don't speak LSP.
- **Both a Core parser and a tree-sitter grammar in v1:** two front ends to keep in step from the start.
- **Tooling in both Go and TS:** written twice, drifting, with no parity to catch it.
- **The LSP asking a running Host for its Grants:** editing would need a live Host, and the answer could change under the editor.
- **No Host-specific knowledge in tooling:** no completion of Operations, error codes or messages, which is most of what an embedded language's editor is for.
- **Library signatures in the manifest instead of source:** a new signature format, when Libraries are already Host-supplied source the LSP can check directly.
- **A formatter that wraps long lines:** newlines end statements (ADR 0019), so adding or removing line breaks risks changing meaning, and the formatter would need a line-breaking rule for every construct.
- **Formatter options** (indent width, blank-line policy): every project would look different, for no gain.
- **A debugger that edits variables while paused:** the run would stop matching any Trace, and replay would no longer reproduce it.
- **A debug pause recorded as a Host Input:** debugging would change the Trace it was meant to explain.
- **A separate Go debugger for live Go Hosts:** replaying the Go Host's Trace on the TS Core gives the same run, by parity.

## Consequences

- **The normative line:** narrows ADR 0019.
  - Normative, as before: the first syntax error, every checker diagnostic, the display form, the source map (ADR 0010), the lowering, and Session Transcripts (ADR 0014).
  - Tooling freedom: the formatter's output, the LSP's features, Lints (ADR 0027) and the debugger. None of these adds a corpus case kind.
- **The front end:** narrows ADR 0019.
  - The TS Core's parser produces a lossless syntax tree, keeps going after the first error, and feeds its checker. The tooling uses this tree, and the Core compiles from the same parse.
  - The first error the tooling reports is the Core's, so it can't differ from the normative one.
- **Where the tooling runs:**
  - It is TS only: the LSP, formatter, Lint engine and debugger, under Bun or Node and in a browser worker.
  - The Go REPL keeps only the REPL. It has no Lints (ADR 0027), formatter or debugger.
- **The Host Manifest:** narrows ADR 0015.
  - A Host exports one manifest per kind of Script, e.g. "tenant rule" or "game NPC", through its embedding API.
  - It holds:
    - the Grants, with their Operation Declarations in exactly ADR 0015's data form, including any declared error codes (ADR 0017)
    - the source of each Library the Script may import
    - each message the Script may receive, with its argument Shape and the kinds of Host Object that receive it
    - the Host Object kinds, the kinds of parent each may have (ADR 0016), and the well-known object names bound at load
    - the language version and the Host's own manifest version
  - It is tooling-only and not normative. A stale manifest can only mislead tooling, since the Core still checks Grants and object names at load.
  - A Handler for a message the manifest doesn't declare gets the Lint `unknown-message` (hint / hint), never an error.
  - The Playground builds its manifest from its own Grants.
- **The v1 LSP features:**
  - **Diagnostics:** the normative errors and the Lints.
  - **Completion:** Operations from the Grants; `catch` patterns from declared error codes; names from Imports; message names from the manifest; Units and chunk words where the grammar allows them.
  - **Hover:** a Constant's value in the display form, an Operation's Declaration, a Function Value's Home Script.
  - **Navigation:** go-to-definition and find-references across Imports, and rename.
  - **Suspension marks:** a mark on every Suspension Point and every may-suspend Handler or Lambda. These add to the `wait` that ADR 0019 requires in the source, and never replace it.
  - **Formatting:** the formatter, through the LSP.
  - Everything else, such as semantic highlighting and code actions beyond quick-fixes for Lints, is left to the implementation.
- **The formatter:**
  - It has no options.
  - It never adds or removes a line break, since newlines end statements. It changes only indentation (2 spaces per block), spacing within a line, and runs of blank lines (at most one is kept).
  - It keeps every comment exactly, re-indenting only, and never changes a token's spelling.
  - Tooling tests hold it to two invariants: formatting is idempotent, and it never changes the Disassembly.
- **The debugger:**
  - It has two modes. Live runs against the TS Core, in the Playground or a Bun Host. Replay runs from any Trace, including one taken on a Go Host.
  - **Breakpoints:** a breakpoint maps through the source map to an instruction and pauses the whole Script Group at that instruction boundary. This is a tooling-only hook in the TS Core.
  - **While paused:** the Group is inspected through the same Script Snapshot rendering that `:runs`, `:mailbox` and `:vars` use (ADR 0014). Resuming continues the same Run.
  - **Not a Host Input:** a pause costs no Fuel and leaves the Trace unchanged. Fuel Slices count Fuel, not time, so they're unaffected.
  - **Stepping:** step in, over and out work at the statement level.
    - Stepping over a Suspension Point continues until this Run resumes past it. Other Runs execute meanwhile, and a breakpoint in any of them pauses the Group.
    - Stepping into a foreign Function Value call or a `send … and wait` follows the message into the receiving Run, following the causal chain rather than the stack.
    - The view shows each Run's Segment number and the Fuel it has used.
  - **The Clock:** in live mode the debugger Host supplies Clock readings and subtracts paused time, so deadlines don't all fire at once on resume. In replay mode the readings come from the Trace.
  - **Faults:** "break on Error" (caught or uncaught) and "break on Limit Fault" pause before the rollback, so the state that caused the fault can be seen.
  - **No edits:** the debugger never writes Script state. Changing code is stop-and-reload, as at the REPL.
  - **Reverse stepping:** replay mode offers "run to Host Input *n*" and reverse steps, by replaying again from the start or from a snapshot. It needs no extra recording.
- **The Playground:** narrows ADR 0014.
  - It ships the LSP in a worker, the formatter, live debugging, and replay debugging of a pasted Trace.
  - A shared link carries the source and, optionally, a Session Transcript. Opening it replays the session, so a bug report can arrive as a link and be debugged in replay mode.
- **Left for later:**
  - The Host Manifest's file format and the embedding-API call that exports it, written with the final signatures.
  - The exact debug hook in the TS Core (how a pause at an instruction boundary is requested), written with the TS Core.
  - A tree-sitter grammar for editors that don't speak LSP.
