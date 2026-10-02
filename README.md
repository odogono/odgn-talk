# NorthTalk

A HyperTalk-descended scripting language for running untrusted end-user Scripts in a sandbox. New here? Take the [language tour](docs/tour.md). The rules are in [the spec](spec/).

NorthTalk originates with ODGN (Open Door Go North). Scripts use `.talk` files; the repository remains `odogono/odgn-talk`. The [naming decision](docs/adr/0039-the-language-name-stands-apart-from-its-publisher.md) records the package and tooling names and preliminary clash checks.

The TS Core implements pinned Unicode, immutable text/value foundations and a lossless lexer/parser for [#126](https://github.com/odogono/odgn-talk/issues/126). See [the implementation guide](impl/ts/README.md) for the supported API, checks, corpus selection and remaining work. Scripts do not execute yet.

Notable implementation changes are recorded in the [changelog](impl/ts/CHANGELOG.md).

## Layout

The [layout decision](docs/adr/0046-each-core-lives-under-impl-beside-a-shared-spec.md) records why the repository is arranged this way.

- [`spec/`](spec/): the Spec and its Data Files, the authority every Core answers to.
- [`corpus/`](corpus/): the Conformance Corpus, which every Core runs.
- [`impl/ts/`](impl/ts/): the TS Core, `@odgn/northtalk`, with its Session Host and tests.
- `impl/go/`: the Go Core, module `github.com/odogono/odgn-talk/impl/go`, once its work begins.
- `tooling/`: the TS tooling stack (LSP, formatter, Lint engine, debugger, Playground), none of it normative.
- [`tools/`](tools/): the Spec checks and the generators that write each Core's tables from the Data Files.
- [`spikes/`](spikes/): finished experiments the ADRs cite, kept as evidence.
- [`docs/`](docs/): the tour, the ADRs and research notes.

Run `bun install` at the root. `bun run check` runs the Spec checks; `bun run test`, `bun run typecheck` and `bun run build` run across the workspaces.
