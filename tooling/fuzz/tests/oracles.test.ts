import { expect, test } from 'bun:test';
import { generate, witnesses } from '../src/generator';
import { checkCase, compareTraces, traceInvariants } from '../src/oracles';
import { execute } from '../src/runner';

test('all oracle families execute on deterministic scheduler witnesses without false positives', () => {
  const checks = new Set<string>();
  for (const c of witnesses()) {
    const result = checkCase(c);
    expect(result.findings).toEqual([]);
    for (const check of result.checks ?? []) {
      checks.add(check);
    }
  }
  for (const family of [
    'save-restore',
    'rollback',
    'limit-sweep',
    'fingerprint',
    'metamorphic',
    'trace-invariant',
  ]) {
    expect(checks.has(family)).toBe(true);
  }
});

test('Trace invariants catch duplicate terminal outcomes but allow unfinished Runs', () => {
  expect(
    traceInvariants([
      'seg a/r1 start handler=go fuel=1 alloc=0 state=1 end=ask-wait',
    ]),
  ).toEqual([]);
  const lines = [
    'run a/r1 outcome=completed fuel=1 alloc=0',
    'run a/r1 outcome=completed fuel=1 alloc=0',
  ];
  expect(traceInvariants(lines)[0]?.signature).toMatchObject({
    oracle: 'trace-invariant',
    record: 'run',
    owner: 'a:go',
  });
});

test('same-input comparison never hides differences in ids, Fuel or code identity', () => {
  for (const [a, b] of [
    ['> load a identity=abc', '> load a identity=def'],
    [
      'run a/r1 outcome=completed fuel=1 alloc=0',
      'run a/r2 outcome=completed fuel=1 alloc=0',
    ],
    [
      'run a/r1 outcome=completed fuel=1 alloc=0',
      'run a/r1 outcome=completed fuel=2 alloc=0',
    ],
  ]) {
    expect(compareTraces([a!], [b!])?.signature.oracle).toBe('differential');
  }
});

test('known diagnostic mutations are checked, not treated as valid-case load failures', () => {
  const c = generate('1', { mutation: 'wrong-mode' });
  expect(checkCase(c).findings).toEqual([]);
  c.expectedDiagnostic = 'unknown name';
  expect(checkCase(c).findings[0]?.signature.oracle).toBe('diagnostic');
});

test('one-Segment rollback detects altered vars at a fault', () => {
  const c = generate('1', { features: ['loop'], witness: true });
  const execution = execute(c);
  // Use a standalone, controlled before/after Pump observation to avoid duplicate-line indexing.
  execution.trace = [
    '> vars',
    'vars a count=0',
    '> pump clock=2026-10-02T00:00:00Z',
    'fault a/r1 limit=fuel at=a:8 pos=4:1',
    'seg a/r1 start handler=spin fuel=10 alloc=0 state=1 end=fault',
    'pumped state=idle fuel=10',
    '> vars',
    'vars a count=1',
  ];
  const result = checkCase(c, execution, { relations: false });
  expect(result.findings.some(f => f.signature.oracle === 'rollback')).toBe(
    true,
  );
});
