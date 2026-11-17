// @northtalk/editor: CodeMirror 6 extensions for a NorthTalk code field, with
// no framework and no language server (ADR 0182).
import type { Extension } from '@codemirror/state';
import { northtalkLanguage } from './language';
import { northtalkHighlighting, northtalkTheme } from './theme';

export { northtalkLanguage } from './language';
export { northtalkHighlighting, northtalkTheme } from './theme';
export {
  diagnosticsSpec,
  offsetOf,
  positionOf,
  type Diagnostic,
  type DiagnosticsOptions,
  type Position,
} from './diagnostics';

/** NorthTalk's language, highlighting and theme, as one extension. */
export const northtalk = (): Extension => [
  northtalkLanguage,
  northtalkHighlighting,
  northtalkTheme,
];
