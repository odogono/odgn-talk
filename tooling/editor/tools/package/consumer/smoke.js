// The checks Node, Bun and the browser all run: plain JavaScript, imported
// unchanged by each.
import { ensureSyntaxTree } from '@codemirror/language';
import { forEachDiagnostic } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import { diagnosticsSpec, northtalk } from '@northtalk/editor';

export const expect = (ok, message) => {
  if (!ok) {
    throw new Error(message);
  }
};

export const source = 'put "hi" into x -- greet\nadd 2 to x';

/** Highlights a short Script and sets diagnostics on it; returns the state. */
export const smoke = () => {
  let state = EditorState.create({ doc: source, extensions: [northtalk()] });
  const tokens = new Set();
  ensureSyntaxTree(state, state.doc.length, 5000).iterate({
    enter: node => {
      tokens.add(node.name);
    },
  });
  for (const token of ['keyword', 'string', 'comment', 'number']) {
    expect(tokens.has(token), `no ${token} token in ${[...tokens]}`);
  }

  const diagnostics = [
    {
      range: {
        start: { line: 1, character: 4 },
        end: { line: 1, character: 5 },
      },
      severity: 1,
      message: 'Expected a list',
      code: 'type',
    },
    {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 3 },
      },
      severity: 4,
      message: 'Consider set',
    },
  ];
  expect(
    diagnosticsSpec(state, diagnostics, { checked: 'stale' }) === null,
    'stale diagnostics were applied',
  );
  state = state.update(
    diagnosticsSpec(state, diagnostics, { checked: source }),
  ).state;
  const shown = [];
  forEachDiagnostic(state, (d, from, to) => shown.push({ ...d, from, to }));
  expect(shown.length === 2, `${shown.length} diagnostics shown`);
  const error = shown.find(d => d.severity === 'error');
  expect(
    error?.message === 'Expected a list (type)' &&
      source.slice(error.from, error.to) === '2',
    `error diagnostic: ${JSON.stringify(error)}`,
  );
  expect(
    shown.some(d => d.severity === 'hint' && d.message === 'Consider set'),
    'hint diagnostic',
  );
  return state;
};
