import { expect, test } from 'bun:test';
import { list, num, text, Value } from '../src/values';
import { builtin, equals, member, order } from '../src/operations';
import { sizeOf } from '../src/costs';

// A value shared [v, v] n deep has 2^n logical paths through n + 1
// distinct nodes (#890). Comparisons walk distinct pairs once but
// charge every logical pair.
const shared = (n: number, leaf: Value): Value => {
  let v = leaf;
  for (let i = 0; i < n; i++) {
    v = list(v, v);
  }
  return v;
};

test('equality of shared values is linear in nodes and logical in scanned', () => {
  const a = shared(30, num(1));
  const b = shared(30, num(1));
  const c = shared(30, num(2));
  expect(a.equals(b)).toBe(true);
  expect(a.equals(c)).toBe(false);
  // Each list pair counts 1 plus its items' counts: 2^(n+1) - 2 in all.
  expect(equals(a, b, false)).toEqual({ equal: true, scanned: 2 ** 31 - 2 });
  // A differing leaf is found down the first path: 30 item pairs, then
  // the number pair counts 0.
  expect(equals(a, c, false)).toEqual({ equal: false, scanned: 30 });
  expect(order(a, c)).toBe(-1);
  expect(order(c, a)).toBe(1);
});

test('membership and min/max charge what each item compares', () => {
  const a = shared(10, text('x'));
  const b = shared(10, text('x'));
  const found = member(a, list(num(0), b), false);
  // Item 1 differs by kind (1 + 0); item 2 is equal (1 + self-scan).
  expect(found.result.asBool()).toBe(true);
  expect(found.scanned).toBe(1 + 1 + (2 ** 11 - 2 + 2 ** 10));
  const measure: { scanned?: number } = {};
  const best = builtin('min', [list(b, a)], measure);
  expect(best.result.equals(a)).toBe(true);
  expect(best.scanned).toBe(1 + 1 + (2 ** 11 - 2 + 2 ** 10));
});

test('logical size of a shared value is measured once per node', () => {
  const a = shared(30, num(1));
  const size = sizeOf(a);
  // A leaf is 16; each wrap is 16 + 8 * 2 + twice the child's size.
  let expected = 16;
  for (let i = 0; i < 30; i++) {
    expected = 32 + 2 * expected;
  }
  expect(size).toBe(expected);
});
