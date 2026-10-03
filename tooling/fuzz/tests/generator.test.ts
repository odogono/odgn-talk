import { expect, test } from 'bun:test';
import { generate, witnesses } from '../src/generator';
import { execute } from '../src/runner';

test('a seed produces the same sources, choices and symbolic schedule', () => {
  expect(generate('42')).toEqual(generate('42'));
  expect(generate('43')).not.toEqual(generate('42'));
});

test('scheduler witnesses load and reach their promised behavior', () => {
  const expected: Record<string, string> = {
    compute: 'end=return',
    dispatch: 'clause=2',
    suspend: 'op=remote.get',
    join: 'end=join-end',
    decision: 'decided ',
    error: 'raise ',
    scope: 'action=opened',
    effect: 'phase=commit',
    loop: 'limit=fuel',
    send: 'send ',
    timer: 'end=wait',
  };
  for (const c of witnesses()) {
    const result = execute(c);
    expect(result.trace.filter(l => l.startsWith('diag '))).toEqual([]);
    const feature = c.choices.scripts[0]!.handlers[0]!.kind;
    expect(result.trace.some(l => l.includes(expected[feature]!))).toBe(true);
    expect(result.counts.applied).toBeGreaterThan(0);
  }
});

test('intentional invalid mutations have their independently declared diagnostic', () => {
  for (const mutation of [
    'wrong-mode',
    'after-suspension',
    'bad-suffixes',
    'missing-grant',
    'impure-guard',
  ] as const) {
    const c = generate('1', { mutation });
    const result = execute(c);
    const diagnostics = result.trace.filter(l => l.startsWith('diag '));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain(
      `code=${JSON.stringify(c.expectedDiagnostic)}`,
    );
  }
});

test('inapplicable symbolic actions are counted no-ops without invented Trace records', () => {
  const c = generate('5', { features: ['compute'] });
  c.inputs = [
    { kind: 'answer', nth: 0, value: '9' },
    { kind: 'cancel-run', script: 'a', nth: 0 },
  ];
  const result = execute(c);
  expect(result.counts).toMatchObject({ applied: 0, noops: 2 });
  expect(result.trace).toEqual([]);
});
