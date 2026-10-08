# NorthTalk tooling

**Current limitation:** the [Session observation contract](../../spec/session-observation.md) is only partly implemented here. The formatter keeps `--|` Declaration Documentation attached, which the Core extracts. Hover doesn't show it yet, and the new observation commands and object-crossing replay are still unavailable ([#440](https://github.com/odogono/odgn-talk/issues/440)).


`@odgn/northtalk-tooling` is the browser-safe TypeScript tooling stack over
`@odgn/northtalk`. It imports only the Core; file, stdio and process handling
belong to [`tooling/cli`](../cli/). Tooling output is outside conformance parity
([ADR 0028](../../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)).

## Built-in Capabilities

**Recovery Offers:** the formatter, checker/LSP diagnostics and beginner Lints support `offer`, `catch … before unwind` and `choose offer`; the CLI and Playground consume that syntax support. The formatter prints bare zero-argument choices, and each new Advanced Construct suggests a local catch with an explicitly supplied policy callback. Both Cores lower and execute these forms, including nested recovery and cancellation; see the [TS](../../impl/ts/README.md) and [Go](../../impl/go/README.md) support guides. Live and replay stepping follow the active dispatch path, with retained/dispatch frame roles, shared owner locals and an owning-frame index in the tooling-only snapshot. Sessions, CLI and Playground run Library offers chosen by a Session Script and replay their Transcripts; see the [tooling/session evidence](../../docs/reviews/recovery-offers-tooling/README.md) and [tooling contract](../../spec/12-sessions-and-tooling.md#the-debugger).

`@odgn/northtalk-tooling/builtins` exports `calendar` and `locale`, the Host functions of the built-in Standard Capabilities that the REPL and the [Playground](../playground/) offer to `:grant`. They answer from the runtime's `Intl` data, so their answers are each Host's own and outside parity. A Session Transcript records each answer as a `~` line. The Session Host builds `store` in itself, in memory, so a Transcript replays its Store without `~` lines.

## Formatter

```ts
import { formatSource } from '@odgn/northtalk-tooling/format';

const { source, error } = formatSource('on greet\nsay "hello"\nend greet\n');
```

`formatSource` returns `{ source, error }`. A syntax error returns the original
source and the Core's `ParseError`; it never formats a partial tree. Invalid
Unicode scalar text throws the Core's `HostError`, as `parseSource` does.
Checking bindings or supplying a Host Manifest is unnecessary for formatting.

There are no layout options. The formatter uses two spaces per block and one
extra level for continuation lines and `match` / block `wait for` branch heads.
It normalises spacing within each line, preserves token spelling and comment
text, and keeps at most one consecutive blank line outside fenced literals.
Fenced literal values, including trailing spaces and blank lines, are preserved.
Margin-stripped literals align their closing margin and content prefixes with
block indentation; nested literals keep their own margins. Inline-start content
keeps its whitespace. Code inside interpolation holes uses ordinary formatting.
It preserves all other
line breaks, including their LF, CRLF or CR spelling, the BOM, and whether
the source ends in a newline. Comments are only re-indented; trailing comments
have one space before them. Spacing that distinguishes syntax, such as
`say (x)` versus `say(x)` and `< <` versus `<<`, is retained. Labelled
Handler heads, Command Calls, `pass`, event patterns and target-first `send`
keep their labels and parse identically after formatting.

From a clean checkout, with Bun 1.4.2, run these commands at the repository root:

```sh
bun install
bun run northtalk fmt script.talk another.talk
bun run northtalk fmt --check script.talk
printf 'on greet\nsay "hello"\nend greet\n' | bun run northtalk fmt -
```

For Node 22 or later, build the CLI with Bun and run the resulting JavaScript:

```sh
bun run --cwd tooling/cli build
node tooling/cli/dist/main.js fmt script.talk
node tooling/cli/dist/main.js fmt --check script.talk
```

`fmt` writes files in place; `-` reads stdin and writes formatted source to
stdout. `--check` writes nothing and exits with 1 if any file needs formatting.
Syntax errors and file errors also exit with 1, are reported on stderr, and do
not prevent the remaining files from being processed. Broken stdin source is
returned unchanged on stdout unless `--check` is set. Invalid arguments exit
with 2.

`bun run --cwd tooling/stack test` checks idempotence, tokens, comments, line
endings and canonical Disassembly (ignoring instruction source positions) over
every `.talk` file in `corpus/` and `spec/`, including the Standard Libraries,
and every `talk` example in the Spec. Snippets that demonstrate load-time errors
or omit their Host declarations have no Disassembly; their diagnostics are
compared instead. CI also executes the browser bundle with standard Web APIs
and no Bun or Node globals, and tests the CLI under both Bun and Node.

## Lints

`@odgn/northtalk-tooling/lint` is the browser-safe Lint engine over the TS Core's lossless recovering parser. It imports only `@odgn/northtalk`. It runs under Bun, Node, and browser workers; file and process handling belongs to [`tooling/cli`](../cli/). Tooling advice is outside parity and never changes loading, Trace lines or Fuel ([chapter 12](../../spec/12-sessions-and-tooling.md#layers-and-lints), [ADR 0028](../../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)).

```ts
import { lint, lintSyntax, readManifest } from '@odgn/northtalk-tooling/lint';
import { parseSourceRecovering } from '@odgn/northtalk';

const { lints, diagnostics } = lint(source, { profile: 'beginner' });
const advice = lintSyntax(parseSourceRecovering(source).tree, {
  profile: 'standard',
});
const manifest = readManifest(manifestJSON); // Chapter 9's exported JSON.
const hostAdvice = lint(source, { manifest }).lints;
```

`lint` returns advice and syntax recovery diagnostics separately. `lintSyntax` reuses an existing lossless tree. Each Lint has `id`, `level`, `message` and a `span` (`start`, `end`, `line`, `col`). Offsets index the original TS string, and line/column positions are one-based Unicode scalar counts. Advice is sorted by source offset and then id. Error regions and malformed expressions are opaque, while enclosing blocks keep their valid siblings. The caller selects `beginner` or `standard`; the default is `standard`.

The [catalogue](lints.toml) implements all twenty ids, retaining chapter 12's levels and wording templates. The beginner `suggest-collecting` hint recognizes a loop immediately after `put [] into acc` whose body appends an element with `put … after acc`. It points at the loop head and respects binding identity, so shadowing Lambda locals do not trigger it. Binding advice uses the Core checker, while load diagnostics remain separate from Lints. Decode chapter 9's exported JSON with `readManifest(json)` and pass the resulting `HostManifest` as `manifest` to either API. Without a manifest, `unknown-message` emits no advice. Manifest Libraries are checked for their exports without executing their initializers or calling the Host. `checkOptions` supplies additional Core checker context; `bindings` can reuse the `SemanticTree` already checked from the same syntax tree, as the LSP does. Set `checkOptions.unit` to `library` when linting Library source: Library Handlers are not Host message entry points, and `shadows-builtin` describes Script names.

Reachability is conservative: an earlier unguarded clause must cover the later clause's argument count and wildcard/name, literal, list or map patterns. Pins and Text/Binary Patterns are not compared for coverage. Key-emptiness advice recognizes literal maps, immutable map Constants, preceding straight-line map assignments and positive key-presence guards (`"key" is in the keys of m`), including short-circuit `and`. Unquoted Built-in properties and known Host Objects are not map key reads. Caught-error advice follows possible writes through branches, stops at exits and excludes nested Lambda bodies; it flags writes to Script Variables, not locals, and only inside a `try` with a `catch`. These are static hints, not proofs of runtime behavior.

- `advanced-construct` reads generated `grammar.toml` tags and their Beginner Surface replacements. Syntax recognition maps pins, pinned Binary Pattern sizes, code point chunks/properties and lazy Text Pattern elements to those tags; the tags decide whether each is advanced.
- `prefer-explicit-end` flags a bare ending at its `end` token, suggesting the matching name or keyword.
- `suggest-ignoring-case` uses a syntax-only heuristic: a case-sensitive comparison with a word-bearing literal text operand. Variables alone, kind tests and emptiness tests do not establish intent.
- `whole-value-when` flags a whole-value Match branch with a lone literal Text Pattern, such as `when <"WARN">`. Anchored patterns, captures and `when contains` communicate different intent and are left alone.
- `inline-block-lambda` flags a block Lambda within an argument expression; a named Lambda or expression Lambda is left alone.
- `long-join-body` counts physical source lines between the `wait for all` head and its ending, excluding both, including blank/comment lines. More than 20 is long; the threshold lives in the catalogue.
- `plain-send-in-join` and `conditional-join-member` track the nearest Join and `if` bodies within it. Lambda bodies start their own context; an `if` outside a Join does not make its members conditional.
- `ambiguous-ignoring-case` flags a trailing modifier on an `and`/`or` chain, with parentheses marking an explicitly grouped comparison.
- `key-shadows-property` checks map literal keys against the generated Built-in property list, including quoted keys. Destructuring keys are not map literal keys.
- `store-race` follows one Handler in source order, without entering nested Lambdas. An `ask G to get K` taints `it`, a `put` of a tainted expression taints its target, chunk writes included, and a later `ask` or waiting `send` replaces `it`. An `ask G to set K` whose value reads a tainted binding is flagged at `set` when `G` is the same Grant name and `K` is the same literal text, or the same binding with no write in between. Branches and loops are read as straight-line code, so this is a hint about likely lost updates, not a proof.
- `unconvertible-literal` delegates literal Civil Date/Instant conversion to the Core's pure `canConvert` helper. It does not evaluate arbitrary expressions or earlier conversions.

A standalone `-- lint: ignore <id>` comment on the preceding physical line suppresses that id there, without changing parsing. It suppresses neither other ids nor later lines. Suppression uses lossless comment trivia, so directive-looking text literals do not count.

From a clean checkout:

```sh
bun install
bun run northtalk lint --profile beginner example.talk
bun run lints:generate  # after editing the catalogue or grammar tags/properties
bun run lints:check    # detects stale generated tables, also run in CI
bun run --cwd tooling/stack test
bun run --cwd tooling/stack test:node
bun run --cwd tooling/stack build  # browser-target bundle
bun run --cwd tooling/stack test:browser  # open the printed local URL
```

The same positive/negative fixtures run under Bun, Node and the browser smoke page. Lint fixtures are tooling tests, separate from the Conformance Corpus.

## Language server

`@odgn/northtalk-tooling/lsp` exports `createLanguageServer(send)`. Supply a
callback that receives JSON-RPC messages, then pass incoming messages to
`server.handle(message)`. `server.configure({ manifest, sources, profile })`
accepts the Host Manifest as JSON text or decoded data, and workspace sources
as `{ uri, text, library? }`. No file, process or transport API is used; a
browser worker can post the messages directly. `server.exitCode` becomes 0 on
`shutdown` followed by `exit`, or 1 on `exit` without shutdown.

The server supports LSP 3.17 initialization, incremental document changes,
versioned push diagnostics, completion, hover, definition, references,
implementation, call hierarchy, rename, inlay hints, formatting and Lint quick
fixes. Positions are UTF-16, including
CRLF and supplementary Unicode characters; the Core's scalar columns stay
internal. Suspension marks use `textDocument/inlayHint` with a `⏸` label on
Suspension Points and on Handlers or Lambdas that may suspend, including Join
heads. Enable inlay hints in the editor to show them.

Diagnostics combine the first Core syntax error, recovering checker/load
errors and the shipped Lints in `northtalk.profile` (`standard` by default).
Manifest Library source supplies export contracts, suspension information and
bindings; imported Library diagnostics and transitive Grant requirements are
reported at the importing `use` line. Constants are evaluated by the Core's
initializer and shown in the display form. Operations show their manifest
Declaration; Function Values show their Home Script. Formatting delegates to
the formatter, and `prefer-explicit-end` has an insertion quick fix.

Argument Labels participate through their full Selector: `move knight to "e4"`
navigates to `on move piece to square`, separately from an unlabelled `move`.
Static self sends resolve to local Handlers for definition. Completion and hover show labelled source rather than
colon-separated wire names. Manifest `messages[].name` contains the Selector,
with no extra fields; the reader checks its parts and argument count and uses
argument placeholders in completion. Between arguments, completion offers the
next matching label. Legacy `send` completion offers only unlabelled messages.

Messages have senders and implementors, as in Smalltalk's browser. On a message
name in a Handler head, `send`, `pass`, `wait for` event or Command Call,
references lists every `send`, `pass` and Command Call naming that Selector
across the workspace's Scripts and Libraries, whatever the receiver, adding the
Handler Clauses and `wait for` events when the declaration is included.
Implementation lists those Handler Clauses and `wait for` events. The call
hierarchy has an item per Handler Clause: incoming calls are the clauses and
functions that send its Selector, and outgoing calls are the Selectors its
clause sends. A computed `send` name or `pass any message` could send any
Selector, so each is also an incoming call of every message, and an outgoing
call, with the detail `unknown message name`.

Results aren't narrowed by the Message Path. The Host sets parents at run time,
and the Host Manifest doesn't say which Script owns which object, so a `send`
to anything but `me` may reach any Script with a matching Handler, or its
Fallback Handler.

If an unknown Selector's final word is read as a label with no argument (such
as `log error rest` or `say total count`), `likely-argument-label` advice points
at that word alongside the Core's end-of-line error. It appears without a
manifest too and is suppressed for known Handler or manifest Selectors.

Interpolation holes participate in diagnostics, references, rename and Lints as
ordinary code. Raw text and escaped placeholders remain literal. Completion
supplies local names inside unfinished holes and stays silent in literal content,
including an unfinished fence.

Rename follows resolved bindings, retains explicit ending suffixes, and keeps
local aliases separate: renaming an alias changes that alias and its uses;
renaming the exported name changes definitions and import names while retaining
aliases. It rejects reserved words and conflicting bindings. Clients apply the
returned WorkspaceEdit. Library definitions embedded in a manifest and Standard
Library definitions use `northtalk-library:///<name>.talk` URIs. Clients that
open these URIs can fetch their text with the `northtalk/librarySource` request
(`{ uri }`, returning source text or null). A workspace source marked with the
same Library name supplies an ordinary editable file URI instead.

Without a manifest, diagnostics include syntax and binding/syntax Lints, with no
missing-manifest error; grammar completion, formatting and suspension marks
remain available. `unknown-message` appears only with a manifest; normative load diagnostics remain separate from advice.
The server does not infer Host Object property values or run Handlers to obtain
hover values. A browser client needs virtual document support for embedded Library URIs.
The stdio adapter supplies temporary file URIs for generic editors and includes
manifest source updates in rename edits; Standard Library export names are
read-only. Ordinary workspace Library files remain directly editable.

See the [editor setup](../cli/README.md#language-server) for clean-checkout Bun
and Node commands and a generic client configuration. Tests include real stdio
fixture-workspace sessions under both runtimes, browser bundling without Node
or Bun globals, and the browser smoke page's LSP fixtures.

## Live debugger

`@odgn/northtalk-tooling/debug` exports `LiveDebugger`, source breakpoint and
result types, and `renderDebugView`. It works in Bun, Node and browser workers;
the Host supplies the Group, its Grants and lifecycle, and epoch nanoseconds.

```ts
import { compileSource, newGroup } from '@odgn/northtalk';
import { LiveDebugger, renderDebugView } from '@odgn/northtalk-tooling/debug';

const source = 'on go\n put 1 into n\n return n\nend';
const group = newGroup({ name: 'demo', trace: line => console.log(line) });
const script = group.load({ name: 'main', source });
const debug = new LiveDebugger(group, {
  now: () => BigInt(Date.now()) * 1_000_000n,
});
debug.registerSource(compileSource(source, { name: 'main' }).unit!, 'main');
debug.setBreakpoints([{ unit: 'main', script: 'main', line: 2 }]);
script.deliver({ name: 'go' });
const result = debug.pump();
if (result.state === 'paused') {
  console.log(renderDebugView(debug.snapshot(), 'runs'));
  debug.stepOver();
  if (debug.isPaused) debug.resume();
}
```

Register each Script and Library's exact compiled `CodeUnit`, using the same
checker options as the Host (Grants, Libraries and objects). Script registration
can be scoped to its runtime name; Library registration can omit it. Breakpoints
use one-based line and column positions from the Core source map. A line-only
breakpoint selects its first emitted instruction; a column selects the nearest
mapped column at or after it on that same line. No mapped instruction means
`verified: false`; it never moves to another line. Optional `script` and `run`
selectors restrict the pause. `setBreakpoints` replaces the list and returns its
resolved positions and instructions; `clearBreakpoints` removes it.

`pump`, `resume`, `step`, `stepOver` and `stepOut` return either a completed
`PumpResult` or `{ state: 'paused', pause }`. A paused result is provisional:
the retained Pump has not emitted `pumped` or returned its reports. Resume or
step it until the result is complete. A pause stops every Run in the Group.
Stepping is by statement; over waits through a suspension while other Runs
execute, and into/out follows waiting sends and foreign Function Values.
Breakpoints in every Run remain active during steps. An intervening breakpoint
replaces the pending step; start a new step from that pause if desired.

`pauseOn({ error: true, limitFault: true })` replaces the fault settings. Errors,
caught or uncaught, and Limit Faults pause before unwinding or rollback. `current`
contains the Run, Script, code unit, Handler, instruction, source position and
fault details. `snapshot()` works only while paused and reads through the Core
hook, without the `Inspect()` Host Input. Its detached views include Variables,
mailboxes and Runs with Segment, lifetime Fuel, frames and locals.
`renderDebugView(snapshot, 'runs' | 'mailbox' | 'vars')` prints Session-style rows
prefixed with each Script's name, adding Segment and Fuel to Runs.

`clock()` subtracts cumulative paused wall time from the Host's readings and
clamps rounding regressions. `pump()` uses it by default. An explicit `pump(now,
options)` uses the supplied reading unchanged, for a virtual Clock or Trace
comparison. Schedule a returned `nextDeadline` against `debug.clock()`, and
continue a `sliced` result with another Pump. No Pumps run during a debug pause.
Pause and inspection add no Trace lines or Fuel charges; corpus Trace Cases are
compared with and without the debugger in both ordinary and save/restore replay.
CI exercises the shared live-debugging fixtures in Node and browser bundles.

The debugger has no Script-state setters. Change code with the Host's Reload,
then register the replacement lowering to rebind the stored breakpoints. Reload
is refused while a Pump is paused: first resume it to completion. Use one live
debugger per Group. The [Bun CLI](../cli/README.md#live-debugger) exercises this API.
DAP is outside the scope of this transport.

## Replay debugger

`ReplayDebugger` uses the Core's browser-safe Trace replay driver, shared with the
Trace Case runner and its `Stubs`. Supply a Trace and its chapter 11 setup, with
each Script and Library's source in `text`, or provide a source reader:

```ts
import { ReplayDebugger } from '@odgn/northtalk-tooling/debug';

const debug = new ReplayDebugger({
  scripts: [{ name: 's', source: 's.talk', text: source }],
}, trace);
debug.setBreakpoints([{ unit: 's', line: 2 }]);
debug.resume();
if (debug.isPaused) {
  debug.stepOver();
  debug.reverseStep();
  console.log(debug.snapshot());
}
debug.runToHostInput(0);
```

The `ReplaySetup` type describes Scripts, Libraries, Grant declarations, Limits,
Standard Capabilities and Host Objects as a Trace Case does. The source reader
runs only during construction; reverse navigation reuses those captured sources.
No live Host is called: recorded results, errors, charges, property answers and
lifecycle outcomes answer crossings, and every Pump reads its recorded Clock.
Explicit Stub inputs use the same queues as the Session Host and corpus runner.

Breakpoints, `pauseOn`, `current`, `snapshot`, `step`, `stepOver` and `stepOut`
work as in live mode. Breakpoints set before Load are initially unverified and
bind when their code is loaded; Reload, extensions and restores rebind them.
`resume()` runs across Pumps until a pause or `{ state: 'ended' }`. Each recorded
early Stop or CancelRun pauses with reason `replay` and its `hostInputIndex` at
the recorded `pc`, before applying that input on resume. Inspection adds no
Host Input. `trace` is a detached copy of the Trace produced so far; `reports`
contains completed Pump reports. End-of-Trace validates the replay and reports
the first divergent record.

`runToHostInput(n)` uses zero-based indices, counting every `> ` line, including
Stubs and inputs inside Pumps. It reconstructs execution from the start and
stops before the input, returning `{ state: 'input', hostInputIndex: n }`, or an
early landing pause. A Stop or CancelRun made synchronously by a Host callback
has no instruction boundary inside that callback; its seek result has
`applied: true` and shows the safe boundary after that Pump. `hostInputCount`
and `hostInputIndex` expose the range and current position. Seeking ignores
intervening user breakpoints and fault breaks, which remain set for resuming.

`reverseStep()` reconstructs statement boundaries from the start, then replays
to the previous one in execution order across Runs and Pumps. It works at a
pause or after the Trace ends. Before the first statement it returns to Host
Input 0. No instruction recording or extra Trace lines are needed; long Traces
cost proportionally more to rewind. The debugger never sets Script state or
edits the recorded sources. Bun, Node and browser fixtures exercise replay and
reverse navigation; corpus tests compare every Trace Case and Session
Transcript's `case.trace` with replay-debugging output.
