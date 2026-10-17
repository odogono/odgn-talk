# NorthTalk browser editor

The NorthTalk editor that the [Playground](../playground/) and the [creative tool](../creative/) share. It is CodeMirror 6 with NorthTalk highlighting, the language server's diagnostics, completion, hover, go to definition, references and rename, and its suspension marks. The language server itself is the tooling stack's ([`@northtalk/tooling/lsp`](../stack/)), run in a worker. None of this is normative ([ADR 0028](../../docs/adr/0028-tooling-is-one-ts-stack-and-nothing-it-produces-is-normative.md)).

## Using it

- **`@northtalk/editor/editor`:** `northtalkEditor(uri, lsp, hooks, bindings)` returns the editor's extensions for one document. A page puts its own gutters and marks before them, and passes its own keys in `bindings`. `diagnosticsSpec` turns the language server's diagnostics into a CodeMirror transaction, and `refreshHints` fetches the suspension marks.
- **`@northtalk/editor/lsp-client`:** `LspClient` talks to the LSP worker over `postMessage`.
- **`@northtalk/editor/language`:** the NorthTalk highlighting.
- **`@northtalk/editor/lsp-protocol`:** the messages between a page and the LSP worker.
- **The worker:** a page builds [`src/lsp.worker.ts`](src/lsp.worker.ts) as one of its entry points and starts it with `new Worker('./lsp.worker.js', { type: 'module' })`.

Highlighting colours come from the page's CSS variables `--keyword`, `--string`, `--number`, `--comment` and `--operator`.

## Testing

```sh
bun test tooling/editor/tests
```
