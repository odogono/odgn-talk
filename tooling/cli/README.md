# `northtalk`

The `northtalk` command: the TS REPL, replaying Session Transcripts, formatting source, Lints, the language server, and live debugging ([chapter 12](../../spec/12-sessions-and-tooling.md)). Sessions use [`@odgn/northtalk/session`](../../impl/ts/src/session/), which decides everything a session prints and records. Formatting and Lints use the shared tooling stack. Formatting uses [`@odgn/northtalk-tooling/format`](../stack/), which works on the Core's lossless syntax tree. The prompt, line editing, `:help`, `:quit`, formatting and the command line are outside parity.

```sh
northtalk [repl] [--transcript <file>]
northtalk replay <transcript> [--trace <file>]
northtalk fmt [--check] <file>…
northtalk fmt [--check] -
northtalk lint [--profile beginner|standard] [--manifest <file>] <file>...
northtalk lsp
northtalk debug <script> [--trace <file>]
northtalk test [--manifest <file>] [--only <text>] [<path>…]
```

- **Entries:** a line that parses as a whole Entry runs at once. One that runs out of source, such as `on greet name`, goes on at a `|` prompt until the whole Entry is complete. This includes unfinished fences and interpolation holes, with blank literal lines preserved as content; final EOF reports the innermost unfinished construct at its opener.
- **The foreground:** while the latest Entry's Run waits only for a deadline under the real Clock, the REPL sleeps until it. While it waits on `console`'s `read`, the next line answers it. Otherwise the prompt returns, and the REPL pumps at each background deadline.
- **Ctrl-C** is `:cancel` of the Run the prompt waits for, and a Transcript records it as `:cancel`. At the prompt it drops an unfinished Entry.
- **`--transcript <file>`** records the session as it goes: each Entry and recorded Session Command, each real Clock reading, each line typed for `read`, and each line printed.
- **`replay`** replays a Transcript through a fresh Session Host, and exits with 1, naming the first differing line, when it doesn't print the same. `--trace` writes the Trace the replay took, ending with `> vars`, as a corpus case's `case.trace` does.
- **`fmt`** formats files in place with no layout options. `--check` writes nothing and exits with 1 on unformatted files; `-` reads stdin and writes source to stdout. Syntax errors leave source untouched, report the Core's error on stderr, and exit with 1. Other files are still processed. See the [formatter guide](../stack/README.md#formatter) for the layout rules and clean-checkout Bun and Node commands.
- **Built-in Capabilities** for `:grant`: `clock`, and `calendar` and `locale` answered from the runtime's Intl data ([`builtins.ts`](../stack/src/builtins.ts), shared with the Playground), as in `:grant cal calendar Europe/London` or `:grant loc locale de-CH`. Without a binding they default to `UTC` and `und`. Their answers are this Host's own, and a Transcript records each one as a `~` line, so a replay never consults Intl.

From the repository root, `bun run repl` and `bun run northtalk …` run it without installing.

From a clean checkout, run `bun install`, then `bun run northtalk fmt script.talk`.
For Node 22 or later, run `bun run --cwd tooling/cli build`, then
`node tooling/cli/dist/main.js fmt script.talk`. The REPL remains Bun-only.

## Lints

From a clean checkout, run `bun install`, then:

```sh
bun run northtalk lint example.talk
bun run northtalk lint --profile beginner example.talk another.talk
bun run --cwd tooling/cli build
node tooling/cli/dist/main.js lint --profile beginner example.talk
```

The shared [Lint engine](../stack/) supplies advice in `standard` by default. It prints `file:line:column: level [id] message` on stdout, with the Core's original source positions. Both shipped profiles contain only hints and warnings; Lints never reject a Script or make the command fail. Syntax errors are separate, printed on stderr; recovery lets advice after an error appear too. Exit codes are 0 for advice alone, 1 for syntax errors, and 2 for invalid arguments or file errors. The command implements all nineteen catalogue entries using the Core parser and checker without loading or executing the Script. Add `--manifest host.talk-manifest.json` to supply chapter 9's Host Manifest, including Library and well-known Object bindings. `unknown-message` is silent without a manifest. Checker load diagnostics do not become Lints or change the lint command's exit status; an invalid or unreadable manifest is a file/argument error (exit 2).

A standalone `-- lint: ignore <id>` comment suppresses that id on the next physical line. Blank lines break adjacency. The [catalogue](../stack/lints.toml) records wording, profile levels and the Join threshold. The linter leaves source files unchanged. The REPL remains Bun-only.

## Testing Scripts

`northtalk test` runs the tests an author writes for their own Scripts ([ADR 0056](../../docs/adr/0056-user-scripts-are-tested-by-a-black-box-test-script.md)). This section is the whole convention. It is Tooling, not normative, and a runner for another Core can follow it as written.

```sh
bun run northtalk test
bun run northtalk test --manifest host.talk-manifest.json examples/
bun run northtalk test --only testIncrements counter.test.talk
```

- **What runs:** each path is a file or a directory searched recursively, skipping dot directories and `node_modules`. The default is `.`. Two kinds of file are tests:
  - A **Test Script** (`*.test.talk`): each parameterless Handler named `test` and then a capital, such as `on testIncrements`, is one test.
  - A **Session Transcript** (`*.transcript`): it is one test, replayed as `northtalk replay` replays it, with its own `:grant` and `:mock` lines.
- **The Group:**
  - Every test gets a fresh Script Group.
  - It holds every other `.talk` file in the Test Script's directory, each named by its file stem, and the Test Script itself, named `<stem>Test`.
  - The Test Script reaches the others only by message: `send inc to counter and wait`.
  - An optional `on setup` runs before each test.
- **Grants:**
  - Every Script gets `console`, a `clock`, a `calendar` in UTC and the root `locale`. Each Grant in the `--manifest` Host Manifest is also given as a mock with the manifest's Operation Shapes, and the manifest's Libraries are loaded.
  - Without a manifest, a Script that uses another Capability doesn't load.
  - Host Objects and `timer` aren't offered.
- **The harness Capability:** granted to the Test Script only. `<op>` names a manifest Operation as `<grant>.<operation>`, or `console.read`.
  - `tell harness to stub "<op>", value` queues an answer for the next call of `<op>`.
  - `tell harness to stubFail "<op>", {code: "…", …}` queues a failure for it.
  - `ask harness to calls "<op>"` gives the argument lists of every call so far, oldest first.
  - `ask harness to advance 3 s and wait` moves the Clock on. Each deadline it passes fires in order.
  - A call of an immediate or suspending Operation with nothing queued fails with `unstubbed call`. A fire-and-forget call is only recorded.
- **The test Library:** `use assert, assertEqual from test`.
  - `assert(condition, message)` throws `{code: "assertion failed", message}` unless `condition` is `true`.
  - `assertEqual(actual, expected)` throws `{code: "assertion failed", expected, actual}` unless they are equal under `=`.
  - Any other `throw` fails a test too.
- **The Clock:**
  - Each test starts at `2026-01-01T00:00:00Z`.
  - Time moves only on `advance`, or when the test waits with nothing else able to run. Then it jumps to the next deadline, so `wait for reply or 10 s` times out at once.
  - A test that waits for something that can never come fails.
- **The pass rule:** a test passes when its Run completes, no Run in the Group errors and no message goes unhandled. After the test Run ends, the Group runs on to idle without moving the Clock, so a background error still fails it.
- **Output:**
  - stdout has `ok <file> <test>` for a pass.
  - A failure prints `FAIL <file>:<line>:<col> <test>`, each problem indented, and the console output as `  | ` lines. The position is where the error was raised. For an assertion, or a failure with no position, it's the Test Handler's.
  - A summary line ends the output.
  - `--only <text>` keeps the tests whose `<file> <test>` contains the text.
  - Exit codes: 0 when every test passes, 1 on any failure or when no tests are found, and 2 for invalid arguments, a missing path or an invalid manifest.

## Language server

From a clean checkout, with Bun 1.4.2 and Node 22 or later:

```sh
bun install
bun run --cwd tooling/cli build
node tooling/cli/dist/main.js lsp
# Or run the source directly under Bun:
bun tooling/cli/src/main.ts lsp
```

The command waits for LSP messages on stdin and writes only Content-Length
framed JSON-RPC messages to stdout. An editor launches this process; ordinary
terminal input is not the protocol. Set the editor's language ID to `northtalk`
for `*.talk` files. Use an absolute checkout path so launch does not depend on
the editor's working directory. For any generic LSP client, use:

```json
{
  "languageId": "northtalk",
  "extensions": [".talk"],
  "command": "node",
  "args": ["/absolute/path/odgn-talk/tooling/cli/dist/main.js", "lsp"],
  "initializationOptions": {
    "northtalk": {
      "profile": "beginner",
      "manifest": "demo.talk-manifest.json"
    }
  }
}
```

Map these fields to your client's process, file-type and initialization settings.
For Bun, set `command` to `bun` and the first argument to the absolute
`tooling/cli/src/main.ts` path. `northtalk.profile` accepts `beginner` or
`standard`; omit it for `standard`. `northtalk.manifest` is optional: a relative
path is resolved against the first workspace root, and an absolute path is used
as supplied. Without this setting the server selects the single
`*.talk-manifest.json` file in the workspace roots. Several matches produce a
`host manifest` diagnostic asking for configuration; no match silently gives
grammar-only features. Invalid or unreadable manifests produce a diagnostic and
also preserve grammar features.

For [Neovim 0.11's built-in LSP client](https://neovim.io/doc/user/lsp/), after the build:

```lua
vim.filetype.add({ extension = { talk = 'northtalk' } })
vim.lsp.config('northtalk', {
  cmd = { 'node', '/absolute/path/odgn-talk/tooling/cli/dist/main.js', 'lsp' },
  filetypes = { 'northtalk' },
  root_markers = { '.git' },
  init_options = { northtalk = { profile = 'beginner' } },
})
vim.lsp.enable('northtalk')
-- Enable suspension marks in the attached buffer:
vim.lsp.inlay_hint.enable(true)
```

For [Helix](https://docs.helix-editor.com/languages.html), add to `languages.toml`:

```toml
[language-server.northtalk]
command = "node"
args = ["/absolute/path/odgn-talk/tooling/cli/dist/main.js", "lsp"]
config = { profile = "beginner" }

[[language]]
name = "northtalk"
scope = "source.northtalk"
file-types = ["talk"]
language-servers = ["northtalk"]
roots = [".git"]
```

A generic VS Code LSP client can use the same process configuration and
`northtalk` document selector; the server needs no dedicated NorthTalk extension.
The editor must recognize the file's language ID. Enable inlay hints to show
suspension marks. A syntax grammar is not required for these LSP features.

The server indexes workspace `.talk` files, ignoring hidden directories,
`node_modules`, `dist` and symlinks. Manifest Library source is checked without
the Host. A workspace file named `<library>.talk` overrides that Library's
embedded source for editing and navigation; other files are Scripts. Open
buffer contents override disk text until close. Save and
`workspace/didChangeWatchedFiles` reload workspace files and manifests. Clients
that support dynamic watched-file registration receive watchers for `.talk` and
`.talk-manifest.json`. Configuration is read from initialization options,
`workspace/configuration` when supported, and
`workspace/didChangeConfiguration` notifications. Each successful update
refreshes diagnostics for open documents.

The [server API guide](../stack/README.md#language-server) describes virtual
Library URIs, rename semantics and the shipped Lints. For generic editors the stdio adapter materializes manifest and Standard
Library sources into temporary files, removed when the server exits. Definition
locations use those file URIs. Renaming a manifest Library export returns edits
for its temporary file, importing Scripts and the manifest's embedded source
(only the affected JSON source string changes). Apply and save all returned edits. Save any direct edits to the manifest source before renaming its Library exports. Ordinary
workspace Library files are edited directly; changes there do not rewrite the
manifest. Standard Library exports cannot be renamed. The REPL remains Bun-only.

CI's `bun test tests` includes the Bun stdio integration session;
`bun run --cwd tooling/cli build` followed by
`bun run --cwd tooling/cli test:node` runs the same fixture workspace under Node.

## Live debugger

From a clean checkout, with Bun 1.4.2:

```sh
bun install
bun run northtalk debug demo.talk --trace demo.trace
```

The file is loaded as one Script, named from its filename without `.talk`. Add
breakpoints before delivering a message; nothing runs until `:run`. For example,
with `on go` starting at line 1:

```text
:break 2
:errors on
:limits on
:run go
:runs
:mailbox
:vars
:step
:over
:out
:continue
:quit
```

`:break <line>[:<column>]` adds a breakpoint, reporting its mapped position or
that it is unverified. `:clear` removes every breakpoint. `:run [message]`
delivers a zero-argument message, defaulting to `go`. `:step`, `:over` and `:out`
step by statement; `:continue` resumes. Inspection commands require a pause.
`:errors on|off` and `:limits on|off` toggle fault breaks. `:help` lists commands;
`:quit` or EOF ends the debugger, including an unfinished paused Run.

The Host pumps automatically through Fuel caps and deadline waits, using the
live debugger's adjusted Clock so time at a breakpoint does not expire waits.
A pause retains the Pump and shows its source position, Run and any fault.
`:runs` includes Segment and lifetime Fuel. Inspection and control add no Host
Inputs or Trace lines. `--trace` writes the Core's Trace through the point of
exit. The Trace path must refer to a different file from the Script, including
through symlinks or hard links. Runtime Errors, Limit Faults and effect failures
give exit code 1; file,
load or argument failures give 2. Invalid interactive commands print an error
and keep the prompt available.

`:reload` reads the file again and uses Reload with `carry variables`, then
rebinds breakpoints. First resume any paused Pump to completion. The CLI never
writes the source or sets Variables. This minimal Bun Host loads one Script,
without Grants, Host Objects or user Libraries, and delivers messages without
arguments. For richer Hosts and worker integration, use the
[browser-safe programmatic API](../stack/README.md#live-debugger). This command
provides live mode; the same command also offers Trace replay.

## Replay debugger

From a clean checkout:

```sh
bun install
bun run northtalk debug --trace corpus/counters/lifetime/case.trace
```

With no Script argument, `--trace` reads an existing Trace. Its adjacent
`case.toml` supplies Script, Library and Grant declarations, as for a Trace
Case; sources are relative to that setup file. `--setup <file>` chooses another
TOML or JSON setup, including inline `text` sources. A Session Transcript case
uses its adjacent `session.transcript` to reconstruct its initial Session
Script, mock Grants and user Libraries.

```text
:break s:3
:continue
:vars
:back
:step
:input 0
:clear
:continue
:quit
```

`:break <unit>:<line>[:<column>]` chooses a Script, extension or Library; omit
the unit when the setup has one Script. Breakpoints bind as their code loads.
Forward stepping, fault breaks and paused inspection use the live commands.
`:back` reverses one statement in execution order, including after the Trace
ends. `:input <n>` seeks to a zero-based Host Input index, counting every `> `
line. It replays from the start, ignoring intervening user breaks. Early Stop
and CancelRun inputs pause at their recorded instruction; callback inputs have
an applied checkpoint after their Pump. See the
[API](../stack/README.md#replay-debugger) for boundary details.

There are no timer-driven Pumps or live Host calls in replay. The Trace file
and sources are read without modification. `:continue` prints completed Run
reports and `end of Trace` after verifying the recorded outputs. Runtime
faults give exit code 1; setup, argument, interactive-command or Trace
divergence failures give 2. Replay has no `:run` or `:reload` commands.
