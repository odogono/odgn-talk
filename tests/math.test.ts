import { describe, expect, test } from 'bun:test';
import { compileSource } from '../src/lowering';
import { deliver, loadScript } from '../src/machine';
import { formatDec, parseDec } from '../src/decimal';
import { BINARY32, BINARY64, readFloat, writeFloat } from '../src/floats';
import { num } from '../src/values';

// A `go` Handler's result, or its error map without `message` and `at`.
const value = (expr: string): string => {
  const compiled = compileSource(`on go\n  return ${expr}\nend go`, {
    name: 't',
  });
  if (!compiled.unit) {
    return `load ${compiled.error?.code ?? compiled.diagnostics.map(d => d.code).join(', ')}`;
  }
  const outcome = deliver(loadScript(compiled.unit, {}), 'go', [], {}).finish();
  if (outcome.kind === 'completed') {
    return outcome.result.toString();
  }
  if (outcome.kind === 'errored') {
    const entries = outcome.error
      .entries()
      .filter(([k]) => k !== 'message' && k !== 'at');
    return `error ${entries.map(([k, v]) => `${k}: ${v}`).join(', ')}`;
  }
  return outcome.kind;
};
const tiny = `0.${'0'.repeat(6175)}1`;

describe('correctly rounded number functions', () => {
  // Each expected value is the exact one rounded half-even to 34 digits, from
  // Python's decimal module at 160 digits.
  test.each([
    ['sqrt(2)', '1.414213562373095048801688724209698'],
    [
      'sqrt(9999999999999999999999999999999999)',
      '99999999999999999.99999999999999999',
    ],
    ['sqrt(1.000000000000000000000000000000001)', '1'],
    ['exp(1)', '2.718281828459045235360287471352662'],
    ['exp(78.28)', '9921379074055385470221097619489176'],
    ['exp(0.000000000000000000000000000000000000001)', '1'],
    ['ln(2)', '0.6931471805599453094172321214581766'],
    [
      'ln(9999999999999999999999999999999999)',
      '78.28789316179755325661170945926838',
    ],
    [
      'ln(1.000000000000000000000000000000001)',
      '0.0000000000000000000000000000000009999999999999999999999999999999995',
    ],
    [
      'ln(0.9999999999999999999999999999999999)',
      '-0.0000000000000000000000000000000001',
    ],
    ['log10(2)', '0.301029995663981195213738894724493'],
    [
      'log10(1.000000000000000000000000000000001)',
      '0.0000000000000000000000000000000004342944819032518276511289189166049',
    ],
    ['power(2, 0.5)', '1.414213562373095048801688724209698'],
    ['power(10, 33.99)', '9772372209558106826970760069615612'],
    ['power(1.0000000000000002, 0.5)', '1.000000000000000099999999999999995'],
    [
      'power(1.00000000000000020000000000000001, 50000000000000000.5)',
      '22026.46579480670770637158272260002',
    ],
    ['power(8, 0.3333333333)', '1.999999999861370563892815468255625'],
    ['sin(1)', '0.841470984807896506652502321630299'],
    [
      'sin(3.141592653589793238462643383279503)',
      '-0.0000000000000000000000000000000001158028306006248941790250554076922',
    ],
    [
      'sin(9999999999999999999999999999999999)',
      '0.2414430295482752256999762633270003',
    ],
    [
      'cos(1.570796326794896619231321691639751)',
      '0.0000000000000000000000000000000004420985846996875529104874722961539',
    ],
    [
      'cos(9999999999999999999999999999999999)',
      '-0.970414995495510001376546271797825',
    ],
    [
      'tan(1.570796326794896619231321691639751)',
      '2261938930836633226244288822199802',
    ],
    ['tan(-0.785)', '-0.9992039901050426572857779586755745'],
    [
      'asin(0.9999999999999999999999999999999999)',
      '1.570796326794896605089186067908801',
    ],
    [
      'acos(0.9999999999999999999999999999999999)',
      '0.00000000000000001414213562373095048801688724209698',
    ],
    [
      'acos(-0.9999999999999999999999999999999999)',
      '3.141592653589793224320507759548552',
    ],
    [
      'atan(9999999999999999999999999999999999)',
      '1.570796326794896619231321691639751',
    ],
    ['atan2(-1, -0.5)', '-2.034443935795702735445577923100966'],
    ['atan2(0, -1)', '3.141592653589793238462643383279503'],
    ['atan2(-1, 0)', '-1.570796326794896619231321691639751'],
  ])('%s', (call, expected) => {
    expect(value(call)).toBe(expected);
  });

  test('exact values come out exact, with trailing zeros dropped', () => {
    expect(value('[sqrt(4), sqrt(2.25), sqrt(0.0400), sqrt(0)]')).toBe(
      '[2, 1.5, 0.2, 0]',
    );
    expect(
      value('[exp(0), ln(1), log10(1000), log10(0.001), log10(100.0)]'),
    ).toBe('[1, 0, 3, -3, 2]');
    expect(value('[sin(0), cos(0), tan(0), asin(0), acos(1), atan(0)]')).toBe(
      '[0, 1, 0, 0, 0, 0]',
    );
    expect(
      value(
        '[power(4, 0.5), power(0.25, 1.5), power(0.25, -1.5), power(1.44, 1.5), power(16, 0.75)]',
      ),
    ).toBe('[2, 0.125, 8, 1.728, 8]');
  });

  test('an integer power is `x ^ y`, keeping its exponent', () => {
    expect(
      value('[power(2.50, 2), power(0.30, 6), power(-2, 3), power(0, 0)]'),
    ).toBe('[6.2500, 0.000729000000, -8, 1]');
  });

  test('a result too small rounds, at exponent -6176 or to 0', () => {
    expect(value(`sqrt(${tiny})`)).toBe(`0.${'0'.repeat(3087)}1`);
    expect(value(`sin(${tiny})`)).toBe(tiny);
    expect(value(`atan(${tiny})`)).toBe(tiny);
    expect(value(`asin(${tiny})`)).toBe(tiny);
    expect(value('[exp(-14222.5), exp(-20000), power(10, -6176.5)]')).toBe(
      '[0, 0, 0]',
    );
    expect(value(`ln(${tiny})`)).toBe('-14220.76553433122614449511522413063');
  });

  test('overflow and domains', () => {
    expect(value('exp(78.29)')).toBe('error code: "overflow", operator: "exp"');
    expect(value('power(10, 34.001)')).toBe(
      'error code: "overflow", operator: "power"',
    );
    expect(value('power(10, 34)')).toBe(
      'error code: "overflow", operator: "power"',
    );
    expect(value('sqrt(-1)')).toBe(
      'error code: "out of domain", function: "sqrt", value: -1',
    );
    expect(value('ln(0)')).toBe(
      'error code: "out of domain", function: "ln", value: 0',
    );
    expect(value('log10(-2)')).toBe(
      'error code: "out of domain", function: "log10", value: -2',
    );
    expect(value('asin(1.0000000001)')).toBe(
      'error code: "out of domain", function: "asin", value: 1.0000000001',
    );
    expect(value('acos(-1.5)')).toBe(
      'error code: "out of domain", function: "acos", value: -1.5',
    );
    expect(value('power(-8, 0.5)')).toBe(
      'error code: "out of domain", function: "power", value: -8',
    );
    expect(value('atan2(0, 0)')).toBe(
      'error code: "out of domain", function: "atan2", value: 0',
    );
    expect(value('power(0, -0.5)')).toBe('error code: "division by zero"');
    expect(value('power(0, -1)')).toBe('error code: "division by zero"');
    expect(value('power(0, 0.5)')).toBe('0');
    expect(value('sqrt(4 kg)')).toBe(
      'error code: "wrong kind", expected: "number", got: "quantity", value: 4 kg',
    );
  });
});

describe('floats', () => {
  test('reading', () => {
    expect(value('fromFloat32(<<0x3D, 0xCC, 0xCC, 0xCD>>)')).toBe('0.1');
    expect(
      value(
        'fromFloat64(<<0x9A, 0x99, 0x99, 0x99, 0x99, 0x99, 0xB9, 0x3F>>, "little")',
      ),
    ).toBe('0.1');
    expect(value('fromFloat32(<<0x80, 0, 0, 0>>)')).toBe('0');
    expect(value('fromFloat32(<<0, 0, 0, 1>>)')).toBe(`0.${'0'.repeat(44)}1`);
    expect(value('fromFloat64(<<0, 0, 0, 0, 0, 0, 0, 1>>)')).toBe(
      `0.${'0'.repeat(323)}5`,
    );
    expect(value('fromFloat32(<<0x4C, 0, 0, 0>>)')).toBe('33554432');
  });

  test('writing', () => {
    expect(value('toFloat64(1.5, "little")')).toBe(
      '<<0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xF8, 0x3F>>',
    );
    expect(value('toFloat32(0.1)')).toBe('<<0x3D, 0xCC, 0xCC, 0xCD>>');
    expect(value('toFloat32(9999999999999999999999999999999999)')).toBe(
      '<<0x77, 0xF6, 0x84, 0xDF>>',
    );
    // Ties go to the even float: 2^24 + 1 is halfway between two binary32s.
    expect(value('toFloat32(16777217)')).toBe('<<0x4B, 0x80, 0x00, 0x00>>');
    expect(value('toFloat32(16777219)')).toBe('<<0x4B, 0x80, 0x00, 0x02>>');
    expect(
      value(
        '[toFloat32(0), toFloat32(-0.00000000000000000000000000000000000000000000001)]',
      ),
    ).toBe('[<<0x00, 0x00, 0x00, 0x00>>, <<0x80, 0x00, 0x00, 0x00>>]');
  });

  test('errors', () => {
    expect(value('fromFloat64(<<1, 2, 3, 4>>)')).toBe(
      'error code: "out of domain", function: "fromFloat64", value: <<0x01, 0x02, 0x03, 0x04>>',
    );
    expect(value('fromFloat32(<<0x7F, 0xC0, 0, 0>>)')).toBe(
      `error code: "can't convert", value: <<0x7F, 0xC0, 0x00, 0x00>>, to: "number"`,
    );
    expect(value('fromFloat32(<<0x7F, 0x7F, 0xFF, 0xFF>>)')).toBe(
      `error code: "can't convert", value: <<0x7F, 0x7F, 0xFF, 0xFF>>, to: "number"`,
    );
    expect(value('toFloat64(1, "middle")')).toBe(
      'error code: "out of domain", function: "toFloat64", value: "middle"',
    );
    expect(value('toFloat64(1, 2)')).toBe(
      'error code: "wrong kind", expected: "text", got: "number", value: 2',
    );
    expect(value('fromFloat32("abcd")')).toBe(
      'error code: "wrong kind", expected: "bytes", got: "text", value: "abcd"',
    );
  });

  test('binary64 reads as ECMAScript Number::toString does, and writes back', () => {
    const view = new DataView(new ArrayBuffer(8));
    for (let i = 0; i < 2000; i++) {
      view.setUint32(0, Math.floor(Math.random() * 2 ** 32));
      view.setUint32(4, Math.floor(Math.random() * 2 ** 32));
      const f = view.getFloat64(0);
      if (!Number.isFinite(f) || Math.abs(f) >= 1e34) {
        continue;
      }
      const b = new Uint8Array(view.buffer.slice(0));
      const d = readFloat(b, BINARY64, false)!;
      expect(formatDec(d)).toBe(num(f === 0 ? 0 : f).toString());
      expect(writeFloat(d, BINARY64, false)).toEqual(
        f === 0 ? new Uint8Array(8) : b,
      );
    }
  });

  test('binary32 reads as the shortest decimal that reads back', () => {
    const view = new DataView(new ArrayBuffer(4));
    for (let i = 0; i < 2000; i++) {
      view.setUint32(0, Math.floor(Math.random() * 2 ** 32));
      const f = view.getFloat32(0);
      if (!Number.isFinite(f) || f === 0) {
        continue;
      }
      const d = readFloat(
        new Uint8Array(view.buffer.slice(0)),
        BINARY32,
        false,
      )!;
      expect(Math.fround(Number(formatDec(d)))).toBe(f);
      expect(
        d.coefficient.toString().replace(/0+$/, '').length,
      ).toBeLessThanOrEqual(9);
      const back = writeFloat(parseDec(formatDec(d)), BINARY32, false);
      expect(new DataView(back.buffer).getFloat32(0)).toBe(f);
    }
  });
});
