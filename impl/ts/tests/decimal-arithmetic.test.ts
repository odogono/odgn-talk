import { expect, test } from 'bun:test';
import {
  ArithmeticError,
  divide,
  div,
  digitsOf,
  mod,
  parseDec,
  type Dec,
} from '../src/decimal';
import { arithmetic } from '../src/operations';
import { dec, decodeValue, encodeValue } from '../src/index';
import { decimalParts } from '../src/values';

const tiny = (coefficient: string, exponent = 6176) =>
  '0.' + '0'.repeat(exponent - coefficient.length) + coefficient;
const count = (coefficient: bigint) =>
  digitsOf({ coefficient, exponent: 0, negative: false });

test('digit counts stay exact around powers of ten and beyond JS number range', () => {
  expect(count(0n)).toBe(1);
  for (const exponent of [
    ...Array.from({ length: 80 }, (_, i) => i + 1),
    307,
    308,
    309,
    615,
    616,
    617,
    6176,
    6210,
    100_000,
  ]) {
    const power = 10n ** BigInt(exponent);
    expect(count(power - 1n)).toBe(exponent);
    expect(count(power)).toBe(exponent + 1);
    expect(count(power + 1n)).toBe(exponent + 1);
  }
  let n = 1n;
  for (let i = 0; i < 500; i++) {
    n =
      (n * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) %
      10n ** 100n;
    expect(count(n)).toBe(n.toString().length);
  }
});

const cases = [
  [divide, '1', '8', '0.125'],
  [divide, '3', '6', '0.5'],
  [divide, '2.50', '2', '1.25'],
  [divide, '2.50', '0.5', '5.0'],
  [divide, '1.00', '8', '0.125'],
  [divide, '1.0000', '8', '0.1250'],
  [divide, '1.0000', '2.00', '0.50'],
  [divide, '10', '0.04', '250'],
  [divide, '0.00', '2', '0.00'],
  [divide, '0.00', '0.001', '0'],
  [divide, '1', '3', '0.' + '3'.repeat(34)],
  [divide, '2', '3', '0.' + '6'.repeat(33) + '7'],
  [divide, '1', '7', '0.1428571428571428571428571428571429'],
  [divide, '9'.repeat(34), '2', '5' + '0'.repeat(33)],
  [divide, '9'.repeat(33) + '7', '2', '4' + '9'.repeat(32) + '8'],
  // Termination can require more than 34 decimal places while fitting 34 digits.
  [divide, '1', '17179869184', '0.0000000000582076609134674072265625'],
  [
    divide,
    '1',
    '281474976710656',
    '0.000000000000003552713678800500929355621337890625',
  ],
  // Terminating but over precision: round once with the general fallback.
  [
    divide,
    '1',
    '562949953421312',
    '0.000000000000001776356839400250464677810668945312',
  ],
  [divide, tiny('8'), '8', tiny('1')],
  [divide, tiny('1', 6173), '8', tiny('125')],
  [divide, tiny('1'), '2', tiny('0')],
  [divide, tiny('3'), '2', tiny('2')],
  [divide, tiny('5'), '2', tiny('2')],
  [divide, tiny('7'), '2', tiny('4')],
  [divide, tiny('1'), tiny('8'), '0.125'],
  [divide, tiny('1'), tiny('1'), '1'],
  [div, '7.50', '2', '3'],
  [div, '2.50', '5', '0'],
  [div, '9'.repeat(34), '1', '9'.repeat(34)],
  [div, tiny('1'), tiny('8'), '0'],
  [mod, '7.50', '2', '1.50'],
  [mod, '7', '0.30', '0.10'],
  [mod, '1.00', '0.5', '0.00'],
  [mod, tiny('7'), tiny('2'), tiny('1')],
  // Unequal cohorts retain the finer exponent, including trailing zeros.
  [mod, '1', tiny('9'.repeat(34), 34), tiny('1', 34)],
  [mod, tiny('9'.repeat(34), 34), '1', tiny('9'.repeat(34), 34)],
  [mod, '1', tiny('9'.repeat(34), 35), '0.00000000000000000000000000000000010'],
  [mod, '1', tiny('1'), tiny('0')],
] as const;

for (const [operation, left, right, expected] of cases) {
  test(`${operation.name}: ${left.length > 80 ? 'subnormal' : left} by ${right.length > 80 ? 'subnormal' : right}`, () => {
    for (const negativeLeft of [false, true]) {
      for (const negativeRight of [false, true]) {
        const a = parseDec(`${negativeLeft ? '-' : ''}${left}`);
        const b = parseDec(`${negativeRight ? '-' : ''}${right}`);
        const negative =
          operation === mod ? negativeLeft : negativeLeft !== negativeRight;
        const wanted = parseDec(expected);
        expect(operation(a, b)).toEqual({
          ...wanted,
          exponent: wanted.exponent || 0,
          negative: negative && wanted.coefficient !== 0n,
        });
      }
    }
  });
}

test('integer overflow and division by zero keep their arithmetic faults', () => {
  const one = parseDec('1');
  const zero = parseDec('0.00');
  for (const operation of [divide, div, mod]) {
    expect(() => operation(one, zero)).toThrow(
      new ArithmeticError('division by zero'),
    );
    expect(() => operation(zero, zero)).toThrow(
      new ArithmeticError('division by zero'),
    );
  }
  for (const operation of [divide, div]) {
    expect(() => operation(parseDec('9'.repeat(34)), parseDec('0.1'))).toThrow(
      new ArithmeticError('overflow'),
    );
    expect(() => operation(one, parseDec(tiny('1')))).toThrow(
      new ArithmeticError('overflow'),
    );
  }
});

test('optimized arithmetic results retain immutable decimal parts and canonical encoding', () => {
  for (const [operator, left, right, expected] of [
    ['divide', '1.0000', '8', '0.1250'],
    ['div', '-7.50', '2', '-3'],
    ['mod', '-7.50', '2', '-1.50'],
  ] as const) {
    const a = dec(left);
    const b = dec(right);
    const result = arithmetic(operator, a, b);
    const parts: Dec = decimalParts(result.asDecimal()!);
    expect(Object.isFrozen(parts)).toBe(true);
    expect(Reflect.set(parts, 'coefficient', 0n)).toBe(false);
    expect(result.toString()).toBe(expected);
    expect(encodeValue(result)).toBe(encodeValue(dec(expected)));
    expect(decodeValue(encodeValue(result), () => undefined).toString()).toBe(
      expected,
    );
    expect(a.toString()).toBe(left);
    expect(b.toString()).toBe(right);
  }
});
