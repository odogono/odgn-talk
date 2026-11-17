# @northtalk/editor

A NorthTalk code field for any app: [CodeMirror 6](https://codemirror.net/) extensions with NorthTalk highlighting, a theme, and diagnostics your app sets from outside. It needs no framework and no language server.

NorthTalk is a readable scripting language for embedding in applications. The [Spec](https://github.com/odogono/odgn-talk/tree/main/spec) defines it, and [`@northtalk/ts`](https://www.npmjs.com/package/@northtalk/ts) runs and checks it.

```sh
npm install @northtalk/editor @northtalk/ts @codemirror/state @codemirror/view @codemirror/language @codemirror/lint
```

`@northtalk/ts` and the CodeMirror packages are peer dependencies, so the field highlights with the same Core your app checks with, and shares your app's CodeMirror.

```ts
import { EditorView } from '@codemirror/view';
import { diagnosticsSpec, northtalk } from '@northtalk/editor';

const view = new EditorView({
  doc: 'the length of name > 3',
  extensions: [northtalk()],
  parent: document.querySelector('#field')!,
});

// Later, with results from your own checker, in the LSP's shape:
const checked = view.state.doc.toString();
const results = await checkOnServer(checked);
const spec = diagnosticsSpec(view.state, results, { checked });
if (spec) {
  view.dispatch(spec);
}
```

## Exports

- **`northtalk()`:** the language, highlighting and theme, as one extension.
- **`northtalkLanguage`, `northtalkHighlighting`, `northtalkTheme`:** the same pieces, to use or replace one at a time.
- **`diagnosticsSpec(state, diagnostics, options?)`:** a transaction that replaces the field's diagnostics. Each diagnostic has a zero-based `range` in UTF-16 columns, a `severity` (1 error, 2 warning, 3 information, 4 hint), a `message`, and optionally a `code` and a `source`. Pass `checked`, the text you checked, and it returns `null` when the field has changed since, so late results never land on the wrong characters. Pass `actions` to offer quick fixes.
- **`offsetOf`, `positionOf`:** convert between a document offset and an LSP position.

The field has no key bindings of its own: add CodeMirror's `history`, `keymap` and the rest as your form needs. Show the diagnostics with `@codemirror/lint`'s `lintGutter` if you want a gutter.

## Colours

Tokens take their colours from CSS variables, each with a built-in fallback, so the field looks right without a stylesheet:

```css
:root {
  --northtalk-keyword: #7a3e9d;
  --northtalk-string: #2e7d32;
  --northtalk-number: #b25b00;
  --northtalk-comment: #8a8478;
  --northtalk-operator: #4a4a4a;
}
```
