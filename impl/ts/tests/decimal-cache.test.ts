import { expect, test } from 'bun:test';
import { arithmetic, negated, numberValue } from '../src/operations';
import { decimalParts } from '../src/values';
import { dec, decodeValue, encodeValue, num, readDisplay } from '../src/index';

test('Number construction and readers retain exact, immutable decimal parts', () => {
  for (const [source, canonical, coefficient, exponent, negative] of [
    ['-0.00', '0.00', 0n, -2, false],
    ['002.50', '2.50', 250n, -2, false],
    ['-0xFF', '-255', 255n, 0, true],
    [
      '9223372036854775808',
      '9223372036854775808',
      9_223_372_036_854_775_808n,
      0,
      false,
    ],
    [
      '-9999999999999999999999999999999999',
      '-9999999999999999999999999999999999',
      9_999_999_999_999_999_999_999_999_999_999_999n,
      0,
      true,
    ],
    [
      '0.' + '0'.repeat(6175) + '1',
      '0.' + '0'.repeat(6175) + '1',
      1n,
      -6176,
      false,
    ],
  ] as const) {
    const original = dec(source);
    const encoded = encodeValue(original);
    for (const value of [
      original,
      readDisplay(canonical),
      decodeValue(encoded, () => undefined),
    ]) {
      const decimal = value.asDecimal()!;
      const parts = decimalParts(decimal);
      expect(parts).toEqual({ coefficient, exponent, negative });
      expect(decimalParts(decimal)).toBe(parts);
      expect(Object.isFrozen(parts)).toBe(true);
      expect(Reflect.set(parts, 'coefficient', 123n)).toBe(false);
      expect(value.toString()).toBe(canonical);
      expect(encodeValue(value)).toBe(encoded);
      expect(value.equals(original)).toBe(true);
    }
  }
  expect(decimalParts(num(1e-7).asDecimal()!)).toEqual({
    coefficient: 1n,
    exponent: -7,
    negative: false,
  });
  expect(decimalParts(num(-9_007_199_254_740_993n).asDecimal()!)).toEqual({
    coefficient: 9_007_199_254_740_993n,
    exponent: 0,
    negative: true,
  });
});

test('arithmetic results snapshot their parts and keep quantum and zero sign', () => {
  const input = { coefficient: 250n, exponent: -2, negative: false };
  const original = numberValue(input);
  input.coefficient = 999n;
  input.exponent = 0;
  input.negative = true;
  const negative = negated(original);
  expect(original.toString()).toBe('2.50');
  expect(arithmetic('add', original, num(1)).toString()).toBe('3.50');
  expect(arithmetic('multiply', negative, num(3)).toString()).toBe('-7.50');
  expect(negated(negative).toString()).toBe('2.50');
  const zero = arithmetic('add', original, negative);
  expect(zero.toString()).toBe('0.00');
  expect(decimalParts(negated(zero).asDecimal()!)).toEqual({
    coefficient: 0n,
    exponent: -2,
    negative: false,
  });
  expect(encodeValue(original)).toBe('{"$dec":"2.50"}');
  expect(original.equals(dec('2.5'))).toBe(true);
});
