# Each Core lives under impl/ beside a shared spec

The repository holds one language and several implementations of it, so its layout puts the authority at the top and the implementations side by side beneath it. `spec/` and `corpus/` stay at the root as the language-neutral authority that every Core answers to (ADR 0009). Each Core lives in `impl/<lang>/`: `impl/ts/` is the TS Core, the package `@odgn/northtalk`, and `impl/go/` will be the Go Core, the module `github.com/odogono/odgn-talk/impl/go`. A Core's directory holds the Core, its driver, its Session Host and its tests, because Session Transcripts are normative (ADR 0028) and each Core must replay them through a Session Host of its own. The TS tooling stack, which isn't normative, lives in `tooling/<name>/`. The root `tools/` holds the Spec checks and the generators that write each Core's tables from the Data Files, so the Data Files are shared and the logic isn't. We chose this because putting the Go Core at the root, as ADR 0039 first had it, would mix one Core's files with the authority both answer to. A Go contributor would then work around the TS layout, or a TS contributor around the Go one, and neither Core would look like the reference that ADR 0009 says neither is.

## Considered Options

- **The Go Core at the repository root** (ADR 0039 as first written): a short import path, `github.com/odogono/odgn-talk`, but `.go` files beside `spec/`, and one Core given a place the other lacks.
- **`go/` and `ts/` at the root:** symmetrical, but with nowhere to say that the two are implementations and the rest isn't.
- **`apps/` and `packages/` for the tooling:** the usual monorepo split, but it draws a line, between deployable and library, that the tooling doesn't need. ADR 0028 already calls the whole stack tooling.
- **Everything TS inside `impl/ts/`:** one package, but it hides the non-normative tooling inside the TS Core, and a Go contributor would have to wade through it.
- **A generator in each Core, in the Core's own language:** each Core would be self-contained, but each Data File's reader would be written twice, which is the shared logic that ADR 0009 rules out.

## Consequences

- **The Go module** has the path `github.com/odogono/odgn-talk/impl/go`. Its release tags are prefixed `impl/go/vX.Y.Z`. The driver is `.../impl/go/driver`, the Session Host is `.../impl/go/session`, and the Go REPL is `impl/go/cmd/northtalk`. The Go REPL lives with its Core because ADR 0028 makes it the only Go tooling. The package identifier stays `northtalk`. This amends ADR 0039.
- **`impl/go/`** is created by the first Go Core issue, not before.
- **Workspaces:** the root `package.json` is a private Bun workspace over `impl/ts`, `tooling/*` and `tools`. ESLint, Prettier and the base `tsconfig.base.json` are shared from the root. The Go module stays outside the workspace, and there's no `go.work` until a second Go module exists.
- **Generated tables** are written by `tools/` into each Core's directory and checked in. Each generator's `--check` holds them to the Data Files. The Go emitters come with the Go Core.
- **CI** is split by path. `spec.yml` runs the Spec checks on every change. `ts.yml` runs the TS Core on changes to `impl/ts/`, `tooling/`, `spec/` or `corpus/`. A `go.yml` will run the Go Core on changes to `impl/go/`, `spec/` or `corpus/`. A change to the Spec or the corpus runs every Core.
- **`spikes/`** stays at the root as finished evidence that the ADRs cite, outside the workspaces and CI.
- **Unchanged:** `spec/`, `corpus/` and `docs/` keep their paths, so the schema identity URLs and links into them stay valid.
