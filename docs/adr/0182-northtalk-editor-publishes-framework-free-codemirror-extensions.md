---
status: accepted
---

# @northtalk/editor publishes framework-free CodeMirror extensions

Apps other than Folio want a small NorthTalk code field: one expression or a short Script in a form, with check results shown as underlines ([#2295](https://github.com/odogono/odgn-talk/issues/2295)). We publish `@northtalk/editor` as CodeMirror 6 extensions with no framework and no language server, alongside `@northtalk/ts` ([ADR 0102](0102-npm-packages-publish-under-the-northtalk-scope.md)). The package has one entry. It exports `northtalk()`, which is the language, highlighting and theme as one Extension, the pieces that make it up, and a helper that sets diagnostics in the LSP shape from outside. Folio keeps using the package through `workspace:*`, including the unpublished language-server and breakpoint modules.

- **The Core and CodeMirror are peers:** `@northtalk/ts` is a peer (`>=0.9.0 <1.0.0`), so the field highlights with the same Core the Host checks with. `@codemirror/state`, `view`, `language` and `lint` are peers too, because a second copy of `@codemirror/state` fails at runtime. The editor therefore versions on its own, from `editor-v*` tags.
- **No language server yet:** `lsp-client` stays out of the published entries, so a later `/lsp` subpath can add it. Nothing published needs a module-global hook, `window.prompt` or key bindings. Key behaviour in a form field belongs to the Host.
- **Diagnostics come from the Host:** `code` and `source` are optional. The helper can take the text that was checked, and returns nothing when the document has since changed, so a server's late results never land on the wrong characters.
- **The theme needs no stylesheet:** it is a CodeMirror base theme reading `--northtalk-keyword`, `--northtalk-string`, `--northtalk-number`, `--northtalk-comment` and `--northtalk-operator`, each with a fallback colour. Folio renames its `--keyword` and the others to match.

## Considered Options

- **`@northtalk/ts` as a dependency:** simpler to install, but the field could then parse with a different Core from the one the Host checks with, and highlighting and diagnostics would disagree.
- **Shipping the language server now:** it would bring hover and completion, but it needs a worker and the private Tooling stack. A Host that checks on its own server doesn't need it.
- **Unprefixed variables and a CSS file:** this is what Folio has today, but `--string` and `--number` are likely to clash in someone else's app, and a stylesheet the Host forgets to import breaks the field silently.
