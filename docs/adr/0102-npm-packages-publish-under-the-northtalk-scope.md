# npm packages publish under the @northtalk scope

The TS package is **`@northtalk/ts`**, and every package in the Bun workspace is named under `@northtalk/*`: `@northtalk/cli`, `@northtalk/tooling`, `@northtalk/creative`, `@northtalk/playground` and so on. This amends [ADR 0039](0039-the-language-name-stands-apart-from-its-publisher.md), which named the TS package `@odgn/northtalk`. The TS driver is `@northtalk/ts/driver`. ODGN remains the publisher. We chose this because NorthTalk will publish several packages, so the language name works better as the namespace than as a prefix inside the publisher's. The publisher holds the `@northtalk` npm organisation and the domain northtalk.org. This is the first npm publication ([#1173](https://github.com/odogono/odgn-talk/issues/1173)), so nothing published depends on the old name.

The package is named after its directory, `impl/ts`, as the Go module is named after `impl/go`. The package holds more than one Core's entry point, because `./wasm` runs the Zig Core ([ADR 0097](0097-browser-hosts-may-run-the-zig-reactor-through-the-ts-embedding-api.md)), and it also holds the Session Host, the Store and the driver.

## Considered Options

- **Keeping `@odgn/northtalk`** (ADR 0039): it needs no rename, but every future package would read `@odgn/northtalk-<name>`, with the language name repeated as a prefix.
- **`@northtalk/core`:** the familiar npm convention, but in the glossary a Core is one implementation of the language, and this package holds more than that.
- **`@northtalk/js`:** friendlier to JavaScript-only users, but nothing in the repository uses that name, and the subpaths would no longer match `impl/ts`.
- **The unscoped `northtalk`:** short, and still free, but it leaves no room for sibling packages to share an identity.

## Consequences

- **Unchanged:** the Go module path `github.com/odogono/odgn-talk/impl/go` and its package identifier `northtalk`, the repository `odogono/odgn-talk`, schema identity URLs, and the literal `odgn-talk code identity 1`, so Script and Library identities and saves are unaffected.
- **The VS Code extension** keeps the Marketplace name `northtalk`, because it isn't an npm package.
- **Earlier ADRs, changelog fragments and `impl/ts/CHANGELOG.md` entries** keep the old name as history.
- **The npm organisations** `@northtalk` and `@odgn` are both held by the publisher, so `@odgn` stays available but unused.
- Amended by [ADR 0148](0148-the-go-embedding-publishes-as-northtalk-org-go.md): the Go module path is `northtalk.org/go`.
