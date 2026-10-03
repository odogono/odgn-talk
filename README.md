# NorthTalk

A HyperTalk-descended scripting language for running untrusted end-user Scripts in a sandbox. New here? Take the [language tour](docs/tour.md). The rules are in [the spec](spec/).

NorthTalk originates with ODGN (Open Door Go North). Scripts use `.talk` files; the repository remains `odogono/odgn-talk`. The [naming decision](docs/adr/0039-the-language-name-stands-apart-from-its-publisher.md) records the package and tooling names and preliminary clash checks.

The TS Core parses and checks source, runs Scripts through the embedding API, and provides a Session Host for the REPL and Transcript replay. See [the implementation guide](impl/ts/README.md) for supported behavior and limitations, and its [task navigation table](impl/ts/README.md#task-navigation) for source, Spec and test entry points.

Notable implementation changes are recorded in the [changelog](impl/ts/CHANGELOG.md).

## Layout

The [layout decision](docs/adr/0046-each-core-lives-under-impl-beside-a-shared-spec.md) records why the repository is arranged this way.

- [`spec/`](spec/): the Spec and its Data Files, the authority every Core answers to.
- [`corpus/`](corpus/): the Conformance Corpus, which every Core runs.
- [`impl/ts/`](impl/ts/): the TS Core, `@odgn/northtalk`, with its Session Host and tests.
- `impl/go/`: the Go Core, module `github.com/odogono/odgn-talk/impl/go`, once its work begins.
- [`tooling/`](tooling/): the TS tooling stack (the [`northtalk` command](tooling/cli/), the [formatter](tooling/stack/README.md#formatter) and [Lint engine](tooling/stack/README.md#lints), and later the LSP, debugger and Playground), none of it normative.
- [`tools/`](tools/): the Spec checks and the generators that write each Core's tables from the Data Files.
- [`spikes/`](spikes/): finished experiments the ADRs cite, kept as evidence.
- [`docs/`](docs/): the tour, the ADRs and research notes.

Run `bun install` at the root. `bun run check` runs the Spec checks; `bun run test`, `bun run typecheck` and `bun run build` run across the workspaces.

## The REPL

From a clean checkout, with [Bun](https://bun.sh) 1.4.2:

```sh
bun install
bun run repl                                  # start a session
bun run repl --transcript session.transcript  # and record it as it goes
bun run northtalk replay session.transcript   # replay a recorded session
bun run northtalk replay session.transcript --trace case.trace
bun run corpus:run sessions                   # the corpus's Session Transcripts
```

Enter a declaration, a statement or an expression at the `>` prompt. An unfinished one goes on at a `|` prompt, and an empty line ends it. `:help` lists the Session Commands. Ctrl-C cancels the Run the prompt is waiting for, and Ctrl-D or `:quit` ends the session. `replay` exits with 1 and names the first line that differs when a Transcript doesn't replay the same. See [chapter 12](spec/12-sessions-and-tooling.md) for what a session does, and [`tooling/cli/`](tooling/cli/) for the command.
