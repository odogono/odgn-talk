# NorthTalk

A HyperTalk-descended scripting language for running untrusted end-user Scripts in a sandbox. New here? Take the [language tour](docs/tour.md). The rules are in [the spec](spec/).

NorthTalk originates with ODGN (Open Door Go North). Scripts use `.talk` files; the repository remains `odogono/odgn-talk`. The [naming decision](docs/adr/0039-the-language-name-stands-apart-from-its-publisher.md) records the package and tooling names and preliminary clash checks.

Both Cores parse and check source, run Scripts through the embedding API, and provide a Session Host for the REPL and Transcript replay. See the [Go implementation guide](impl/go/README.md) and [TS implementation guide](impl/ts/README.md) for supported behavior and limitations. For implementation work, use the [Go task map](impl/go/NAVIGATION.md) or [TS and tooling task map](impl/ts/NAVIGATION.md).

Notable implementation changes are recorded in the [changelog](impl/ts/CHANGELOG.md).

## Layout

The [layout decision](docs/adr/0046-each-core-lives-under-impl-beside-a-shared-spec.md) records why the repository is arranged this way.

- [`spec/`](spec/): the Spec and its Data Files, the authority every Core answers to.
- [`corpus/`](corpus/): the Conformance Corpus, which every Core runs.
- [`impl/ts/`](impl/ts/): the TS Core, `@odgn/northtalk`, with its Session Host and tests.
- [`impl/ts/examples/files/`](impl/ts/examples/files/): a runnable Bun Example Host for file cleanup and staged single-file publication in private temporary directories.
- [`impl/go/`](impl/go/): the Go Core, module `github.com/odogono/odgn-talk/impl/go`, with immutable values, decimal arithmetic, Value Encoding, Unicode text primitives, source lowering, standalone machine execution, the Group embedding interface, a Session Host, REPL, Transcript replay and a corpus runner.
- [`tooling/`](tooling/): the TS tooling stack (the [`northtalk` command](tooling/cli/), the [formatter](tooling/stack/README.md#formatter) and [Lint engine](tooling/stack/README.md#lints), the [LSP](tooling/cli/README.md#language-server) and its [VS Code and Cursor extension](tooling/vscode/), the [live](tooling/stack/README.md#live-debugger) and [replay debugger](tooling/stack/README.md#replay-debugger), and the [Playground](tooling/playground/)), none of it normative.
- [`bench/`](bench/): the Benchmark Suite, which times the same Scripts on each Core and checks their Fuel agrees, none of it normative.
- [`tools/`](tools/): the Spec checks and the generators that write each Core's tables from the Data Files.
- [`spikes/`](spikes/): finished experiments the ADRs cite, kept as evidence.
- [`docs/`](docs/): the tour, the ADRs and research notes.

Run `bun install` at the root. `bun run check` runs the Spec checks; `bun run test`, `bun run typecheck` and `bun run build` run across the workspaces. Generator checks require Go 1.27 for `gofmt`; see the [Go guide](impl/go/README.md) for Go build and test commands.

## The REPL

From a clean checkout, with [Bun](https://bun.sh) 1.4.2:

```sh
bun install
bun run repl                                  # start a session
bun run repl --transcript session.transcript  # and record it as it goes
bun run northtalk replay session.transcript   # replay a recorded session
bun run northtalk replay session.transcript --trace case.trace
bun run corpus:run sessions                   # the corpus's Session Transcripts
bun run northtalk test                        # run your own Test Scripts
```

Enter a declaration, a statement or an expression at the `>` prompt. An unfinished one goes on at a `|` prompt until the whole Entry is complete. `:help` lists the Session Commands. Ctrl-C cancels the Run the prompt is waiting for, and Ctrl-D or `:quit` ends the session. `replay` exits with 1 and names the first line that differs when a Transcript doesn't replay the same. See [chapter 12](spec/12-sessions-and-tooling.md) for what a session does, and [`tooling/cli/`](tooling/cli/) for the command. `northtalk test` runs the `*.test.talk` Test Scripts and `*.transcript` files under a path; [Testing Scripts](tooling/cli/README.md#testing-scripts) describes the convention.

## The Playground

The NorthTalk Playground is the REPL's browser counterpart, on the TS Core. It is published at <https://opendoorgonorth.com/odgn-talk/>, rebuilt from each push to `main`. To run it locally:

```sh
bun run playground          # build and serve it at http://127.0.0.1:3927/, rebuilding on change
bun run --cwd tooling/playground build   # a static dist/ any web server can host
```

See [`tooling/playground/`](tooling/playground/) for what it does and how to run the corpus in a browser.
