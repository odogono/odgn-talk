# NorthTalk browser editor

The NorthTalk editor of [Folio](../creative/), the creative tool. It is CodeMirror 6 with NorthTalk highlighting, the language server's diagnostics, completion, hover, go to definition, references and rename, and its suspension marks. The language server itself is the tooling stack's ([`@northtalk/tooling/lsp`](../stack/)), run in a worker. None of this is normative ([ADR 0028](../../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)).

It is also published to npm as [`@northtalk/editor`](tools/package/README.md), for any app that wants a NorthTalk code field ([ADR 0182](../../docs/adr/0182-northtalk-editor-publishes-framework-free-codemirror-extensions.md)). Only the `.` entry is published; the others below are Folio's, through `workspace:*`.

## Using it

- **`@northtalk/editor`:** the published entry. `northtalk()` is the language, highlighting and theme as one extension; `northtalkLanguage`, `northtalkHighlighting` and `northtalkTheme` are its pieces. `diagnosticsSpec(state, diagnostics, { actions, checked })` turns LSP-shaped diagnostics into a CodeMirror transaction, and returns `null` when the document no longer matches `checked`.
- **`@northtalk/editor/editor`:** `northtalkEditor(uri, lsp, hooks, bindings)` returns the editor's extensions for one document. A page puts its own gutters and marks before them, and passes its own keys in `bindings`. `refreshHints` fetches the suspension marks.
- **`@northtalk/editor/breakpoints`:** `breakpointGutter(changed, unverified?)` returns the breakpoint gutter and paused line. `breakpointLines` reads a document's breakpoints, `markVerified` marks those in loaded code, and `pausedAt` shows or clears the paused line. A page styles `.bp`, `.bp-unverified` and `.cm-paused`.
- **`@northtalk/editor/lsp-client`:** `LspClient` talks to the LSP worker over `postMessage`.
- **`@northtalk/editor/language`:** the NorthTalk language mode, `northtalkLanguage`.
- **`@northtalk/editor/lsp-protocol`:** the messages between a page and the LSP worker.
- **The worker:** a page builds [`src/lsp.worker.ts`](src/lsp.worker.ts) as one of its entry points and starts it with `new Worker('./lsp.worker.js', { type: 'module' })`.

Highlighting colours come from the page's CSS variables `--northtalk-keyword`, `--northtalk-string`, `--northtalk-number`, `--northtalk-comment` and `--northtalk-operator`, each with a fallback.

## Testing

```sh
bun test tooling/editor/tests
```

The tarball check packs the built package with the built `@northtalk/ts`, installs both outside the workspace with CodeMirror from npm, then imports them under Node and Bun, typechecks a consumer against TypeScript 5.9 and the latest, and bundles a field with `Bun.build` for Chromium, where it must highlight and underline:

```sh
bun run --cwd impl/ts build
bun run --cwd tooling/editor build && bun run --cwd tooling/editor package:check
```
