import { expect, test } from 'bun:test';
import { parseSource, type SyntaxElement } from '@odgn/northtalk';
import { formatSource } from '../src/format';
import { completion, definition, hover, references } from '../src/lsp/features';
import { readManifest } from '../src/lsp/manifest';
import { analyzeWorkspace, elements } from '../src/lsp/workspace';

const uri = 'file:///labels.talk';
const manifestData = {
  kind: 'board',
  version: '1',
  language: '1.0-rc.2',
  grants: [],
  libraries: [],
  objects: [],
  messages: [
    { name: 'move', args: ['any'] },
    { name: 'move:to:', args: ['any', 'any'] },
  ],
};
const source =
  'on move piece\n return piece\nend move\non move piece to square\n return square\nend move\non demo\n move 1\n move 1 to 2\n send to me: move 3 to 4\nend demo\n';
const analyze = (text = source, withManifest = true) => {
  const manifest = withManifest ? readManifest(manifestData) : null;
  const all = analyzeWorkspace([{ uri, text }], manifest, 'standard');
  return { all, analysis: all.get(uri)!, manifest };
};

const tokens = (s: string) =>
  elements<SyntaxElement>(parseSource(s).tree!)
    .filter(e => e.kind === 'token')
    .map(e => (e.kind === 'token' ? [e.t, e.v] : []));

test('navigation keeps labelled and unlabelled Handlers with the same first word separate', () => {
  const { all, analysis, manifest } = analyze();
  expect(
    definition(all, analysis, source.indexOf('move 1\n'))?.range.start.line,
  ).toBe(0);
  const labelled = source.indexOf('move 1 to');
  expect(definition(all, analysis, labelled)?.range.start.line).toBe(3);
  expect(
    definition(all, analysis, source.indexOf('move 3 to'))?.range.start.line,
  ).toBe(3);
  expect(
    references(all, analysis, labelled, false)
      .map(r => r.range.start.line)
      .sort((a, b) => a - b),
  ).toEqual([5, 8, 9]);
  expect(hover(all, analysis, labelled, manifest)?.contents.value).toContain(
    'on move piece to square',
  );
  expect(
    hover(all, analysis, labelled, manifest)?.contents.value,
  ).not.toContain('move:to:');
});

test('completion presents labelled source in Handler, target-first send, and local command positions', () => {
  for (const line of ['on mo', ' send to me: mo', ' mo']) {
    const text = line.startsWith('on') ? line : `on demo\n${line}`;
    const { all, analysis, manifest } = analyze(text);
    const items = completion(analysis, text.length, manifest, all);
    expect(items.map(i => i.label)).toContain('move arg1 to arg2');
    expect(items.map(i => i.label)).not.toContain('move:to:');
  }
  const text = source.replace(' move 1 to 2', ' mo');
  const { all, analysis, manifest } = analyze(text, false);
  expect(
    completion(analysis, text.indexOf(' mo\n') + 3, manifest, all).map(
      i => i.label,
    ),
  ).toContain('move piece to square');
});

test('manifest messages validate Selector parts and argument counts without new fields', () => {
  expect(readManifest(manifestData).messages).toEqual(['move', 'move:to:']);
  for (const [name, args] of [
    ['move:to', ['any', 'any']],
    ['move:from:', ['any', 'any']],
    ['move:to:', ['any']],
  ] as const) {
    expect(() =>
      readManifest({ ...manifestData, messages: [{ name, args }] }),
    ).toThrow('Selector');
  }
});

test('likely accidental labels get a hint at the word alongside the syntax error', () => {
  for (const call of ['log error rest', 'say total count']) {
    const text = `on log e\nend log\non demo\n ${call}\nend demo`;
    const { analysis } = analyze(text, false);
    const hint = analysis.diagnostics.find(
      d => d.code === 'likely-argument-label',
    );
    expect(hint?.range.start).toEqual({
      line: 3,
      character: call.lastIndexOf(' ') + 2,
    });
    expect(hint?.message).toContain(call.split(' ').at(-1)!);
    expect(hint?.message).toContain('argument');
    expect(
      analysis.diagnostics.some(d => d.source === 'northtalk syntax'),
    ).toBe(true);
  }
  for (const text of [
    'on demo\n put 1 +\nend demo',
    'on log e rest r\nend log\non demo\n log 1 rest\nend demo',
  ]) {
    expect(
      analyze(text, false).analysis.diagnostics.filter(
        d => d.code === 'likely-argument-label',
      ),
    ).toEqual([]);
  }
});

test('formatting labelled heads, commands, sends, pass and event patterns preserves parsing and is idempotent', () => {
  const text =
    'on move piece to square where square > 0, queued\nmove  piece to (square+1)\nsend to me : move piece to square and wait\nwait for move p to s\npass move to\nend move\n';
  const formatted = formatSource(text);
  expect(formatted.error).toBeNull();
  expect(formatted.source).toContain(
    'send to me: move piece to square and wait',
  );
  expect(formatSource(formatted.source)).toEqual(formatted);
  expect(tokens(formatted.source)).toEqual(tokens(text));
});

test('completion offers the next Selector label between arguments', () => {
  for (const line of [
    ' move 1 t',
    ' move 1 ',
    ' send to me: move 1 t',
    'on move piece t',
  ]) {
    const text = line.startsWith('on') ? line : `on demo\n${line}`;
    const { all, analysis, manifest } = analyze(text);
    expect(
      completion(analysis, text.length, manifest, all).map(i => i.label),
    ).toContain('to');
  }
});

test('messages to other receivers do not resolve to local Handlers', () => {
  const text = source.replace('send to me:', 'send to other:');
  const { all, analysis, manifest } = analyze(text);
  expect(definition(all, analysis, text.indexOf('move 3 to'))).toBeNull();
  expect(hover(all, analysis, text.indexOf('move 3 to'), manifest)).toBeNull();
  expect(
    references(all, analysis, text.indexOf('move 1 to'), false).map(
      r => r.range.start.line,
    ),
  ).not.toContain(9);
});

test('local command completion excludes declaration suffixes and expression contexts', () => {
  const text =
    'on move piece to square where square > 0, queued\nend move\non demo\n mo\nend demo';
  const { all, analysis, manifest } = analyze(text);
  const items = completion(analysis, text.indexOf(' mo\n') + 3, manifest, all);
  expect(items.map(i => i.label)).toContain('move piece to square');
  expect(
    items.some(i => i.label.includes('where') || i.label.includes('queued')),
  ).toBe(false);
  const expression = source.replace(' move 1 to 2', ' put mo into result');
  const a = analyze(expression);
  expect(
    completion(
      a.analysis,
      expression.indexOf('put mo') + 6,
      a.manifest,
      a.all,
    ).some(i => i.label.includes(':') || i.label.includes('to square')),
  ).toBe(false);
});

test('legacy send completion offers only unlabelled messages', () => {
  const text = 'on demo\n send mo';
  const { all, analysis, manifest } = analyze(text);
  expect(
    completion(analysis, text.length, manifest, all).map(i => i.label),
  ).toEqual(['move']);
});

test('Selector lint advice uses label words in Script-facing text', () => {
  const { analysis } = analyze(
    'on missing p toward q\nend missing\non missing p toward q\nend missing\n',
  );
  const advice = analysis.diagnostics.filter(
    d => d.code === 'unknown-message' || d.code === 'unreachable-clause',
  );
  expect(advice).toHaveLength(3);
  expect(advice.every(d => d.message.includes('missing toward'))).toBe(true);
  expect(advice.some(d => d.message.includes('missing:toward:'))).toBe(false);
});
