import { expect, test } from 'bun:test';
import { forEachDiagnostic } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import { diagnosticsSpec, northtalk, type Diagnostic } from '../src/index';

const doc = 'put 1 into x\nadd 2 to x';
const at = (line: number, from: number, to: number) => ({
  start: { line, character: from },
  end: { line, character: to },
});

const shown = (diagnostics: Diagnostic[]) => {
  const state = EditorState.create({ doc, extensions: [northtalk()] });
  const after = state.update(diagnosticsSpec(state, diagnostics)).state;
  const found: {
    from: number;
    message: string;
    severity: string;
    to: number;
  }[] = [];
  forEachDiagnostic(after, (d, from, to) =>
    found.push({ from, to, message: d.message, severity: d.severity }),
  );
  return found;
};

test('maps LSP severities, hints included', () => {
  expect(
    [1, 2, 3, 4].map(
      severity =>
        shown([{ range: at(0, 0, 3), severity, message: 'm' }])[0]?.severity,
    ),
  ).toEqual(['error', 'warning', 'info', 'hint']);
});

test('adds the code to the message only when there is one', () => {
  expect(
    shown([
      { range: at(0, 0, 3), severity: 1, message: 'a', code: 'x' },
      { range: at(1, 0, 3), severity: 1, message: 'b' },
    ]).map(d => d.message),
  ).toEqual(['a (x)', 'b']);
});

test('places UTF-16 ranges on their line, clamped to it', () => {
  expect(
    shown([{ range: at(1, 4, 99), severity: 1, message: 'm' }]).map(d =>
      doc.slice(d.from, d.to),
    ),
  ).toEqual(['2 to x']);
});

test('drops results checked against older text', () => {
  const state = EditorState.create({ doc });
  const diagnostics = [{ range: at(0, 0, 3), severity: 1, message: 'm' }];
  expect(
    diagnosticsSpec(state, diagnostics, { checked: 'put 1 into' }),
  ).toBeNull();
  expect(diagnosticsSpec(state, diagnostics, { checked: doc })).not.toBeNull();
});
