// Result Targets on `ask` (ADR 0112, #1340). Staged here until every Core
// parses them; then they move to tools/grammar/sketch and lowering.talk.
import { expect, test } from 'bun:test';
import { parse } from '../grammar/parser';
import { CompileError, compileSource } from './compile';

const ops = (src: string) => {
  const unit = compileSource('s', 'script', src);
  const b = unit.bodies.find(b => b.name === 't')!;
  return unit.code.slice(b.start, b.end).map(i => [i.op, ...i.args].join(' '));
};

test('a local target is moved from it', () => {
  const code = ops(
    'on t item\n  ask world to carries item into carried\n  return carried\nend t\n',
  );
  const i = code.findIndex(c => c.startsWith('ask world carries'));
  expect(code.slice(i, i + 3)).toEqual([
    'ask world carries 1',
    'store 0',
    expect.stringMatching(/^move 0 \d+$/),
  ]);
});

test('a suspending ask takes its target before and wait', () => {
  const code = ops(
    'on t key\n  ask storage to load key into saved and wait\n  return saved\nend t\n',
  );
  const i = code.findIndex(c => c.startsWith('ask-wait'));
  expect(code[i + 1]).toBe('store 0');
  expect(code[i + 2]).toMatch(/^move 0 \d+$/);
});

test('a Script Variable target is stored from it', () => {
  const code = ops(
    'script variable last\non t\n  ask clock to now into last\nend t\n',
  );
  const i = code.findIndex(c => c.startsWith('ask clock'));
  expect(code.slice(i + 1, i + 4)).toEqual([
    'store 0',
    'load 0',
    expect.stringMatching(/^store-var \d+$/),
  ]);
});

test('no target lowers as before', () => {
  const code = ops('on t\n  ask clock to now\nend t\n');
  const i = code.findIndex(c => c.startsWith('ask clock'));
  expect(code[i + 1]).toBe('store 0');
  expect(code[i + 2]?.startsWith('move')).toBe(false);
});

test.each([
  ['  ask g to op x into item 1 of xs', 2, 27],
  ['  ask g to op x and wait into y', 2, 26],
  ['  ask g to op into it', 2, 20],
  ['  tell g to op x into y', 2, 18],
])('reject %s', (line, l, c) => {
  const { error } = parse(`on t x\n${line}\nend t\n`);
  expect(error).toBeTruthy();
  expect([error!.tok.line, error!.tok.col]).toEqual([l, c]);
});

test('a Join Member has no Result Target', () => {
  expect(() =>
    compileSource(
      's',
      'script',
      'on t\n  wait for all\n    ask g to op into y and wait\n  end wait\nend t\n',
    ),
  ).toThrow(CompileError);
});
