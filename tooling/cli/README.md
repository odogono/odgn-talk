# `northtalk`

The `northtalk` command: the TS REPL, replaying Session Transcripts, formatting source, and Lints ([chapter 12](../../spec/12-sessions-and-tooling.md)). Sessions use [`@odgn/northtalk/session`](../../impl/ts/src/session/), which decides everything a session prints and records. Formatting and Lints use the shared tooling stack. Formatting uses [`@odgn/northtalk-tooling/format`](../stack/), which works on the Core's lossless syntax tree. The prompt, line editing, `:help`, `:quit`, formatting and the command line are outside parity.

```sh
northtalk [repl] [--transcript <file>]
northtalk replay <transcript> [--trace <file>]
northtalk fmt [--check] <file>…
northtalk fmt [--check] -
northtalk lint [--profile beginner|standard] <file>...
```

- **Entries:** a line that parses as a whole Entry runs at once. One that runs out of source, such as `on greet name`, goes on at a `|` prompt, and an empty line ends it, so a real syntax error shows.
- **The foreground:** while the latest Entry's Run waits only for a deadline under the real Clock, the REPL sleeps until it. While it waits on `console`'s `read`, the next line answers it. Otherwise the prompt returns, and the REPL pumps at each background deadline.
- **Ctrl-C** is `:cancel` of the Run the prompt waits for, and a Transcript records it as `:cancel`. At the prompt it drops an unfinished Entry.
- **`--transcript <file>`** records the session as it goes: each Entry and recorded Session Command, each real Clock reading, each line typed for `read`, and each line printed.
- **`replay`** replays a Transcript through a fresh Session Host, and exits with 1, naming the first differing line, when it doesn't print the same. `--trace` writes the Trace the replay took, ending with `> vars`, as a corpus case's `case.trace` does.
- **`fmt`** formats files in place with no layout options. `--check` writes nothing and exits with 1 on unformatted files; `-` reads stdin and writes source to stdout. Syntax errors leave source untouched, report the Core's error on stderr, and exit with 1. Other files are still processed. See the [formatter guide](../stack/README.md#formatter) for the layout rules and clean-checkout Bun and Node commands.
- **Built-in Capabilities** for `:grant`: `clock`, and `calendar` and `locale` answered from the runtime's Intl data ([`src/builtins.ts`](src/builtins.ts)), as in `:grant cal calendar Europe/London` or `:grant loc locale de-CH`. Without a binding they default to `UTC` and `und`. Their answers are this Host's own, and a Transcript records each one as a `~` line, so a replay never consults Intl.

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

The shared [Lint engine](../stack/) supplies advice in `standard` by default. It prints `file:line:column: level [id] message` on stdout, with the Core's original source positions. Both shipped profiles contain only hints and warnings; Lints never reject a Script or make the command fail. Syntax errors are separate, printed on stderr; recovery lets advice after an error appear too. Exit codes are 0 for advice alone, 1 for syntax errors, and 2 for invalid arguments or file errors. The command checks syntax and the eleven syntax-based Lints; it does not load the Script or check bindings, Grants or a Host Manifest. Seven catalogue entries remain planned; their scope is recorded on [#241](https://github.com/odogono/odgn-talk/issues/241).

A standalone `-- lint: ignore <id>` comment suppresses that id on the next physical line. Blank lines break adjacency. The [catalogue](../stack/lints.toml) records wording, profile levels and the Join threshold. The linter leaves source files unchanged. The REPL remains Bun-only.
