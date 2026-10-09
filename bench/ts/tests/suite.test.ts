import { describe, expect, test } from 'bun:test';
import {
  check,
  Loaded,
  manifest,
  selected,
  skipped,
  sourceOf,
  sweepSkip,
} from '../src/suite';

describe('the TS Core', () => {
  for (const b of manifest().filter(b => !b.skip?.ts)) {
    test(`${b.name} produces its expected output`, () => {
      expect(check(b, true).fuel).toBeGreaterThan(0);
    });
    test(`${b.name} can repeat on the same loaded Script`, () => {
      const loaded = new Loaded(b, b.name, sourceOf(b));
      const first = loaded.run(b.smoke.n);
      expect(first.outcome).toBe('completed');
      expect(first.result).toBe(b.smoke.expect);
      expect(loaded.run(b.smoke.n)).toEqual(first);
    });
  }

  test('a wrong expected output fails the check', () => {
    const b = manifest()[0]!;
    const wrong = { ...b, smoke: { ...b.smoke, expect: `${b.smoke.expect}0` } };
    expect(() => check(wrong, true)).toThrow(`expected ${wrong.smoke.expect}`);
  });
});

test('a filter selects Benchmarks by a part of their names', () => {
  const b = manifest()[0]!;
  expect(selected(b, undefined)).toBe(true);
  expect(selected(b, b.name.split('/')[0])).toBe(true);
  expect(selected(b, 'absent')).toBe(false);
});

test('a Benchmark lists the runners that skip it', () => {
  const b = { ...manifest()[0]!, skip: { go: 'not supported yet' } };
  expect(skipped(b, ['go', 'ts'])).toEqual([
    { benchmark: b.name, reason: 'not supported yet', runner: 'go' },
  ]);
});

test('a sweep adds one Benchmark per Fuel Slice, with the same Fuel', () => {
  const all = manifest();
  const swept = all.filter(b => b.slice !== undefined);
  expect(swept.length).toBeGreaterThan(0);
  for (const b of swept) {
    const base = all.find(x => x.name === b.script)!;
    expect(b.name).toBe(`${base.name}@slice=${b.slice}`);
    expect(b.skip?.peers).toBe(sweepSkip);
    expect(check(b, true).fuel).toBe(check(base, true).fuel);
  }
});
