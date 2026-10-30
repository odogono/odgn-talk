# NorthTalk

A HyperTalk-descended scripting language for running untrusted end-user Scripts in a sandbox. New here? Take the [language tour](docs/tour.md). The rules are in [the spec](spec/).

NorthTalk originates with ODGN (Open Door Go North). Scripts use `.talk` files; the repository remains `odogono/odgn-talk`. The [naming decision](docs/adr/0039-the-language-name-stands-apart-from-its-publisher.md) records the package and tooling names and preliminary clash checks.

The TS and Zig Cores parse and check source, run Scripts through the embedding API, and provide a Session Host for the REPL and Transcript replay. Both pass the whole Conformance Corpus. Go and Elixir Hosts embed the Zig Core; the native Go Core is retired ([ADR 0117](docs/adr/0117-go-hosts-run-the-zig-core-and-the-go-core-is-retired.md)). See the [TS implementation guide](impl/ts/README.md), [Zig implementation guide](impl/zig/README.md), [Go embedding guide](impl/go/README.md) and [Elixir embedding guide](impl/elixir/README.md) for supported behavior and limitations. For implementation work, use the [Go task map](impl/go/NAVIGATION.md), [TS and tooling task map](impl/ts/NAVIGATION.md), [Zig task map](impl/zig/NAVIGATION.md), [Elixir task map](impl/elixir/NAVIGATION.md) or [Folio task map](tooling/creative/NAVIGATION.md).

Notable implementation changes are recorded in the [changelog](impl/ts/CHANGELOG.md).

To add NorthTalk scripting to a TypeScript app, follow [Embed the TS Core](docs/embedding-typescript.md), with a runnable application-service example.

For SQL-backed Scripts, see [Using SQLite](docs/sqlite.md): queries, transactions,
Host setup and how the implementation works.

## Layout

The [layout decision](docs/adr/0046-each-core-lives-under-impl-beside-a-shared-spec.md) records why the repository is arranged this way.

- [`spec/`](spec/): the Spec and its Data Files, the authority every Core answers to.
- [`corpus/`](corpus/): the Conformance Corpus, which every Core runs.
- [`impl/ts/`](impl/ts/): the TS Core, `@northtalk/ts`, with its Session Host and tests.
- [`impl/ts/examples/files/`](impl/ts/examples/files/): a runnable Bun Example Host for file cleanup and staged single-file publication in private temporary directories.
- [`impl/ts/examples/webhooks/`](impl/ts/examples/webhooks/): a runnable Bun webhook rules Example Host on the real Clock, created with `newDrivenGroup`, with Promise-backed suspending calls cancelled through `AbortSignal`.
- [`impl/go/internal/examples/tenants/`](impl/go/internal/examples/tenants/): a runnable multi-tenant Go Example Host, an HTTP server with a Group per tenant pumped in parallel by the driver Pool.
- [`impl/go/`](impl/go/): the Go embedding, module `northtalk.org/go` ([ADR 0148](docs/adr/0148-the-go-embedding-publishes-as-northtalk-org-go.md)), which runs the embedded Zig Core through wazero, with immutable values, decimal arithmetic, Value Encoding, Unicode text primitives, the Group embedding interface, a Session Host, REPL, Transcript replay and a corpus runner.
- [`impl/zig/`](impl/zig/): the Zig Core for native C and WASI embedding, conforming beside the TS Core and embedded by the Go and Elixir Hosts ([#636](https://github.com/odogono/odgn-talk/issues/636)), with its C interface `talk.h`, the native Message Layer sidecar and WASI reactor, a Session Host, REPL, Transcript replay, a corpus runner and a fuzz worker; see its [implementation guide](impl/zig/README.md) for supported behavior and limitations and its [task map](impl/zig/NAVIGATION.md) for implementation work.
- [`impl/elixir/`](impl/elixir/): the Elixir embedding, `:north_talk`, which drives the Zig Core's WASI reactor in Wasmex without Go ([#963](https://github.com/odogono/odgn-talk/issues/963)).
- [`tooling/`](tooling/): the TS tooling stack (the [`northtalk` command](tooling/cli/), the [formatter](tooling/stack/README.md#formatter) and [Lint engine](tooling/stack/README.md#lints), the [LSP](tooling/cli/README.md#language-server) and its [VS Code and Cursor extension](tooling/vscode/), the [live](tooling/stack/README.md#live-debugger) and [replay debugger](tooling/stack/README.md#replay-debugger), [Folio](tooling/creative/), the creative tool, and its [browser editor](tooling/editor/), and [northtalk.org](tooling/site/), the language site), none of it normative.
- [`bench/`](bench/): the Benchmark Suite, which times the same Scripts on each Core and checks their Fuel agrees, none of it normative.
- [`tools/`](tools/): the Spec checks and the generators that write each Core's tables from the Data Files.
- [`spikes/`](spikes/): finished experiments the ADRs cite, kept as evidence.
- [`docs/`](docs/): the tour, the ADRs and research notes.

Run `bun install` at the root. `bun run check` runs the Spec and doc checks (`bun run spec:check` and `bun run docs:check` run them alone), and the pre-push hook adds `bun run lint` and `bun run format:check`, as CI does; `bun run test`, `bun run typecheck` and `bun run build` run across the workspaces. Generator checks require Go 1.27 for `gofmt`; see the [Go guide](impl/go/README.md) for Go build and test commands, and the [Zig guide](impl/zig/README.md) for Zig ones.

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
bun run northtalk diff-save a.save b.save     # show where two saves differ
```

Enter a declaration, a statement or an expression at the `>` prompt. An unfinished one goes on at a `|` prompt until the whole Entry is complete. `:help` lists the Session Commands. Ctrl-C cancels the Run the prompt is waiting for, and Ctrl-D or `:quit` ends the session. `replay` exits with 1 and names the first line that differs when a Transcript doesn't replay the same. See [chapter 12](spec/12-sessions-and-tooling.md) for what a session does, and [`tooling/cli/`](tooling/cli/) for the command. `northtalk test` runs the `*.test.talk` Test Scripts and `*.transcript` files under a path; [Testing Scripts](tooling/cli/README.md#testing-scripts) describes the convention.

## Licence

NorthTalk is released under the [MIT Licence](LICENSE). Each Core's generated Unicode tables also carry the Unicode licence, which its README describes.
