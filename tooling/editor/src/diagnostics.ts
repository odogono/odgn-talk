// Check results set from outside the editor, in the LSP's shape, so a Host
// that checks on its own server can show them as underlines.
import { setDiagnostics, type Action } from '@codemirror/lint';
import type { EditorState, Text, TransactionSpec } from '@codemirror/state';

/** A zero-based line and UTF-16 column, as LSP 3.17 counts them. */
export type Position = { character: number; line: number };

/** One check result, in the shape of an LSP diagnostic. */
export type Diagnostic = {
  code?: number | string;
  message: string;
  range: { end: Position; start: Position };
  /** 1 error, 2 warning, 3 information, 4 hint; an error when absent. */
  severity?: number;
  source?: string;
};

export type DiagnosticsOptions<D extends Diagnostic> = {
  /** Quick fixes to offer on a diagnostic. */
  actions?: (diagnostic: D) => readonly Action[];
  /**
   * The text the diagnostics were checked against. When the document no
   * longer matches it, `diagnosticsSpec` returns `null`, so late results
   * never land on the wrong characters.
   */
  checked?: string;
};

export const offsetOf = (doc: Text, p: Position): number => {
  const line = doc.line(Math.min(doc.lines, p.line + 1));
  return Math.min(line.to, line.from + p.character);
};

export const positionOf = (doc: Text, offset: number): Position => {
  const line = doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
};

const severities = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' } as const;

/**
 * The diagnostics as a transaction that replaces the editor's current ones;
 * dispatch it on the view. With `checked`, it is `null` when the document has
 * changed since that text was checked.
 */
export function diagnosticsSpec<D extends Diagnostic>(
  state: EditorState,
  diagnostics: readonly D[],
  options: DiagnosticsOptions<D> & { checked: string },
): TransactionSpec | null;
export function diagnosticsSpec<D extends Diagnostic>(
  state: EditorState,
  diagnostics: readonly D[],
  options?: DiagnosticsOptions<D> & { checked?: undefined },
): TransactionSpec;
export function diagnosticsSpec<D extends Diagnostic>(
  state: EditorState,
  diagnostics: readonly D[],
  { actions = () => [], checked }: DiagnosticsOptions<D> = {},
): TransactionSpec | null {
  if (checked !== undefined && state.doc.toString() !== checked) {
    return null;
  }
  return setDiagnostics(
    state,
    diagnostics.map(d => {
      const from = offsetOf(state.doc, d.range.start);
      return {
        from,
        to: Math.max(from, offsetOf(state.doc, d.range.end)),
        severity:
          severities[(d.severity ?? 1) as keyof typeof severities] ?? 'info',
        message:
          d.code === undefined || d.code === ''
            ? d.message
            : `${d.message} (${d.code})`,
        ...(d.source === undefined ? {} : { source: d.source }),
        actions: [...actions(d)],
      };
    }),
  );
}
