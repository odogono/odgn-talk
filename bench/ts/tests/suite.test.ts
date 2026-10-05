import { describe, expect, test } from 'bun:test';
import { check, manifest, selected, skipped } from '../src/suite';

describe('the TS Core', () => {
  for (const b of manifest().filter(b => !b.skip?.ts)) {
    test(`${b.name} produces its expected output`, () => {
      expect(check(b, true).fuel).toBeGreaterThan(0);
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
