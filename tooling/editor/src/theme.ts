// NorthTalk's colours and font. Each colour is a CSS variable a page may set,
// with a fallback, so the editor looks right without any stylesheet.
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

const keyword = 'var(--northtalk-keyword, #7a3e9d)';
const string = 'var(--northtalk-string, #2e7d32)';
const number = 'var(--northtalk-number, #b25b00)';
const comment = 'var(--northtalk-comment, #8a8478)';
const operator = 'var(--northtalk-operator, #4a4a4a)';

/** The colours of NorthTalk's tokens. */
export const northtalkHighlighting: Extension = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.keyword, color: keyword, fontWeight: '600' },
    { tag: tags.labelName, color: keyword, fontStyle: 'italic' },
    { tag: tags.string, color: string },
    { tag: tags.number, color: number },
    { tag: tags.comment, color: comment, fontStyle: 'italic' },
    { tag: tags.operator, color: operator },
  ]),
);

/** A monospace font; a page's own theme overrides it. */
export const northtalkTheme: Extension = EditorView.baseTheme({
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },
});
