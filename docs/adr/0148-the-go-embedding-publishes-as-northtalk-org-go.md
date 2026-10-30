# The Go embedding publishes as northtalk.org/go

The Go embedding's module path is **`northtalk.org/go`**, and its SQLite Capability is a separate module, **`northtalk.org/go/sqlite`**. This amends [ADR 0039](0039-the-language-name-stands-apart-from-its-publisher.md), [ADR 0046](0046-each-core-lives-under-impl-beside-a-shared-spec.md) and [ADR 0102](0102-npm-packages-publish-under-the-northtalk-scope.md), which kept `github.com/odogono/odgn-talk/impl/go`. Both modules stay where they are, in `impl/go` and `impl/go/sqlite`. The northtalk.org Worker ([ADR 0140](0140-northtalk-org-is-one-cloudflare-worker-deployed-from-ci.md)) answers `?go-get=1` with a `go-import` tag whose subdirectory field names that directory, such as `northtalk.org/go git https://github.com/odogono/odgn-talk impl/go`, and a `go-source` tag, so pkg.go.dev links to GitHub. Browsers are redirected to pkg.go.dev. We chose this because the GitHub path ties every import to the repository's layout and name, while the language already owns its domain. It is the first Go publication ([#1512](https://github.com/odogono/odgn-talk/issues/1512)), so nothing published depends on the old path.

The subdirectory field needs Go 1.25 or later, and it was proved before this decision ([#1513](https://github.com/odogono/odgn-talk/issues/1513)): a probe module, `northtalk.org/go-probe`, fetched by pseudo-version with the default `GOPROXY` and `GOSUMDB`. `proxy.golang.org` served it with `"Subdir"` in its origin, `sum.golang.org` recorded its checksums, and pkg.go.dev showed its documentation and licence, with source links to the right GitHub file and line, pinned to the commit.

- **Tags:** `impl/go/vX.Y.Z` and `impl/go/sqlite/vX.Y.Z`, the prefixes the Go command expects for a module in a subdirectory.
- **Versions:** v0 semver until NorthTalk declares language 1.0 ([#142](https://github.com/odogono/odgn-talk/issues/142)). Until then a minor version may break the API.
- **Supported packages:** the root package `northtalk`, `driver`, `session`, `store` and `notify`. Everything else is under `internal/`: the CLI, `internal/cmd/northtalk`, since `@northtalk/cli` owns the `northtalk` command; the Store kit and report tools; the HTTP Host; and the multi-tenant Example Host, `internal/examples/tenants`.
- **The sqlite module** is separate so that only a Host using SQLite downloads its dependencies.
- **Go floor:** `go 1.26` in every Go module, one version behind the current release, as Go itself supports two.
- **Licence:** each module holds a copy of the root `LICENSE`, since a module zip holds only its own directory. `bun run check` fails when a copy drifts.
- **Workspace:** a repository `go.work` covers `impl/go`, `impl/go/sqlite`, `bench/go` and `bench/peers/go`, replacing the `replace` directives in their `go.mod` files, which a consumer would ignore anyway.

## Considered Options

- **Keeping `github.com/odogono/odgn-talk/impl/go`:** it works today with `go get`, needs no Worker and no rename, but it fixes the repository's name and layout into every import, and `impl/go/sqlite` doesn't install, because consumers ignore its `replace`.
- **A separate repository, `github.com/odogono/northtalk-go`:** a conventional root module, but the Go embedding embeds the Zig reactor and is tested against the shared corpus, so it would need a release mirror kept in lockstep.
- **The module at the domain root, `northtalk.org`:** shorter, but it leaves no room for other modules, such as the sqlite one, under the domain.

## Consequences

- **Every import** changes, including `bench/go`, and the Spec's embedding chapter and `spec/embedding/talk.go` name the new path.
- **The Worker** must keep answering both paths, or every `go get` of them fails.
- **Earlier ADRs, changelog fragments and benchmark results** keep the old path as history.
- **The compilation cache** stays an environment variable, `NORTHTALK_ZIG_CACHE_DIR`, because a public option needs `spec/embedding/talk.go` and `talk.h` changes. That option is a follow-up.
