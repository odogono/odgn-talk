import { expect, test } from 'bun:test';
import { generate, pump, witnesses } from '../src/generator';
import { execute } from '../src/runner';

test('a seed produces the same sources, choices and symbolic schedule', () => {
  expect(generate('42')).toEqual(generate('42'));
  expect(generate('43')).not.toEqual(generate('42'));
});

test('Pump clocks use the instant display form, with the shortest fraction', () => {
  expect(pump()).toBe('> pump clock=2026-10-02T00:00:00Z');
  expect(pump(10)).toBe('> pump clock=2026-10-02T00:00:00.01Z');
  expect(pump(7, 30)).toBe(
    '> pump clock=2026-10-02T00:00:00.007Z fuel-slice=30',
  );
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

test('compute generation varies fences and exposes their values to Trace oracles', () => {
  const literals = new Set<string>();
  for (let seed = 1; seed <= 20; seed++) {
    const c = generate(String(seed), { features: ['compute'], witness: true });
    literals.add(c.setup.scripts![0]!.text!);
    const result = execute(c);
    expect(
      result.trace.filter(line => /^(diag|raise|fault) /.test(line)),
    ).toEqual([]);
    expect(
      result.trace.some(
        line =>
          line.startsWith('vars a ') &&
          line.includes('rendered="value 0"') &&
          line.includes('template='),
      ),
    ).toBe(true);
  }
  expect(literals.size).toBeGreaterThan(1);
});
