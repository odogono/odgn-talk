// Typechecked against each supported TypeScript, with the strictest settings
// a consumer might use, so the published declarations hold for all of them.
import {
  EditorState,
  type Extension,
  type TransactionSpec,
} from '@codemirror/state';
import {
  diagnosticsSpec,
  northtalk,
  northtalkHighlighting,
  northtalkLanguage,
  northtalkTheme,
  offsetOf,
  positionOf,
  type Diagnostic,
  type Position,
} from '@northtalk/editor';

export const extensions: Extension[] = [
  northtalk(),
  northtalkLanguage,
  northtalkHighlighting,
  northtalkTheme,
];
const state = EditorState.create({ doc: 'put 1 into x', extensions });
const start: Position = positionOf(state.doc, 4);
export const offset: number = offsetOf(state.doc, start);

type Checked = Diagnostic & { code: string; source: string };
const diagnostics: Checked[] = [
  {
    range: { start, end: { line: 0, character: 5 } },
    severity: 2,
    message: 'Unused',
    code: 'unused',
    source: 'host',
  },
];
export const always: TransactionSpec = diagnosticsSpec(state, diagnostics, {
  actions: (d: Checked) => [{ name: d.code, apply: view => view.focus() }],
});
export const maybe: TransactionSpec | null = diagnosticsSpec(
  state,
  diagnostics,
  {
    checked: state.doc.toString(),
  },
);
