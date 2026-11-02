// The small Decimal lane (#1938) must agree with the `Dec` path: the same
// result, display and digit count (which the charge measures), including at
// the safe-integer and exponent boundaries.
import { describe, expect, test } from 'bun:test';
import {
  add,
  compareDec,
  divide,
  digitsOf,
  formatDec,
  multiply,
  subtract,
  type Dec,
} from '../src/decimal';
import {
  arithmetic,
  comparison,
  exponentOf,
  numberValue,
  smallArithmetic,
  smallCoefficientOf,
} from '../src/operations';
import { decimalParts, type Value } from '../src/values';

const SAFE = Number.MAX_SAFE_INTEGER;
// A deterministic generator, so a failure reproduces.
let seed = 1938;
const random = (): number => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
const coefficients = (): number =>
  pick([
    0,
    1,
    7,
    125,
    SAFE,
    SAFE - 1,
    Math.floor(SAFE / 2),
    94_906_265, // its square is just above the safe integers
    94_906_266,
    Math.floor(random() * 1000),
    Math.floor(random() * SAFE),
  ]) * (random() < 0.5 ? -1 : 1);
const exponents = (): number =>
  pick([0, -1, -3, -8, -3088, -3089, -6176, 0 - Math.floor(random() * 20)]);

const decOf = (c: number, e: number): Dec => ({
  coefficient: BigInt(Math.abs(c)),
  exponent: e,
  negative: c < 0,
});
const valueOf = (c: number, e: number): Value => numberValue(decOf(c, e));
const general = { add, subtract, multiply, divide } as const;
const sameAs = (small: Value, d: Dec) => {
  const parts = decimalParts(small.asDecimal()!);
  expect(small.asDecimal()!.toString()).toBe(formatDec(d));
  expect(parts.exponent).toBe(d.exponent);
  expect(parts.coefficient).toBe(d.coefficient);
  expect(parts.negative).toBe(d.negative && d.coefficient !== 0n);
  expect(digitsOf(parts)).toBe(digitsOf(d));
};

describe('small Decimal lane', () => {
  test('parsed numbers keep a small coefficient and their exponent', () => {
    const v = valueOf(125, -3);
    expect(smallCoefficientOf(v)).toBe(125);
    expect(exponentOf(v)).toBe(-3);
    expect(v.asDecimal()!.toString()).toBe('0.125');
  });

  for (const op of ['add', 'subtract', 'multiply', 'divide'] as const) {
    test(`${op} agrees with the Dec path`, () => {
      let taken = 0;
      for (let i = 0; i < 20_000; i++) {
        const [x, ex, y] = [coefficients(), exponents(), coefficients()];
        const ey = random() < 0.7 ? ex : exponents();
        const small = smallArithmetic(op, x, ex, y, ey);
        let expected: Dec;
        try {
          expected = general[op](decOf(x, ex), decOf(y, ey));
        } catch {
          expect(small).toBeUndefined();
          continue;
        }
        if (small) {
          taken++;
          sameAs(small, expected);
        }
        // The whole operation, small or not, matches too.
        sameAs(arithmetic(op, valueOf(x, ex), valueOf(y, ey)), expected);
      }
      expect(taken).toBeGreaterThan(1000);
    });
  }

  test('comparisons agree with the Dec path', () => {
    for (let i = 0; i < 20_000; i++) {
      const [x, ex, y] = [coefficients(), exponents(), coefficients()];
      const ey = random() < 0.7 ? ex : exponents();
      const o = compareDec(decOf(x, ex), decOf(y, ey));
      const a = valueOf(x, ex);
      const b = valueOf(y, ey);
      expect(comparison('less', a, b, false).result.asBool()).toBe(o < 0);
      expect(comparison('greater-or-equal', a, b, false).result.asBool()).toBe(
        o >= 0,
      );
    }
  });
});
