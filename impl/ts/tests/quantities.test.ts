import { describe, expect, test } from 'bun:test';
import { compileSource } from '../src/lowering';
import { deliver, loadScript } from '../src/machine';
import {
  decodeValue,
  dec,
  encodeValue,
  HostError,
  num,
  quantity,
  range,
  readDisplay,
} from '../src/index';
import { charge, rateOf } from '../src/costs';
import { parseUnit, unitText } from '../src/units';

// The value a `go` Handler returns, or its error map without `message` and `at`.
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

describe('Units', () => {
  test('a Unit reads into one slot per Unit Kind, in Kind order', () => {
    expect(unitText(parseUnit('s*m/kg'))).toBe('m*s/kg');
    expect(unitText(parseUnit('m*m'))).toBe('m^2');
    expect(unitText(parseUnit('inches/s'))).toBe('inch/s');
    expect(unitText(parseUnit('1/s'))).toBe('1/s');
    expect(parseUnit('m/m')).toEqual([]);
    expect(() => parseUnit('m*ft')).toThrow(
      'two Units of the Unit Kind length',
    );
    expect(() => parseUnit('month^1')).toThrow('Calendar Unit');
  });

  test('a Quantity literal naming two Units of one Unit Kind is `bad unit`', () => {
    expect(value('2 m*ft')).toBe('load bad unit');
    expect(value('2 m*m')).toBe('2 m^2');
    expect(value('4 m/m')).toBe('4');
  });
});

describe('Host values', () => {
  test('the display form and Value Encoding round-trip', () => {
    for (const [display, encoding] of [
      ['2.50 GBP', '{"$quantity":["2.50","GBP"]}'],
      ['3 days', '{"$quantity":["3","day"]}'],
      ['-1.0 day', '{"$quantity":["-1.0","day"]}'],
      ['9.8 kg*m/s^2', '{"$quantity":["9.8","kg*m/s^2"]}'],
      [
        '3 m..7 cm',
        '{"$range":[{"$quantity":["3","m"]},{"$quantity":["7","cm"]}]}',
      ],
      [
        '[1.5..2, {a: 0.5 1/s}]',
        '[{"$range":[{"$dec":"1.5"},2]},{"a":{"$quantity":["0.5","1/s"]}}]',
      ],
    ] as const) {
      const v = readDisplay(display);
      expect(v.toString()).toBe(display);
      expect(encodeValue(v)).toBe(encoding);
      expect(decodeValue(encoding, () => null).toString()).toBe(display);
    }
  });

  test('readers refuse a Unit not in normal form, and mixed range ends', () => {
    for (const display of [
      '2 day',
      '1 days',
      '2 s*m',
      '2 m*ft',
      '3 m..7 s',
      '3..7 m',
    ]) {
      expect(() => readDisplay(display)).toThrow(HostError);
    }
    for (const encoding of [
      '{"$quantity":["3","days"]}',
      '{"$quantity":["2.5","s*m"]}',
      '{"$quantity":["02","m"]}',
      '{"$quantity":["4","m/m"]}',
      '{"$range":[1,{"$quantity":["2","m"]}]}',
    ]) {
      expect(() => decodeValue(encoding, () => null)).toThrow(HostError);
    }
  });

  test('`quantity` takes a number and a Unit as a Script spells it', () => {
    const q = quantity(dec('2.50'), 'inches/s');
    expect(q.toString()).toBe('2.50 inch/s');
    expect(q.asQuantity()).toEqual({
      number: dec('2.50').asDecimal()!,
      unit: 'inch/s',
    });
    expect(quantity(num(5), 'kg').equals(quantity(num(5000), 'g'))).toBe(true);
    expect(quantity(num(5), 'kg').equals(quantity(num(5), 'm'))).toBe(false);
    expect(quantity(num(4), 'm/m').toString()).toBe('4');
    expect(() => quantity(num(1), 'parsec')).toThrow(HostError);
    expect(
      range(quantity(num(1), 'm'), quantity(num(2), 'ft')).toString(),
    ).toBe('1 m..2 ft');
    expect(() => range(num(1), quantity(num(2), 'ft'))).toThrow(HostError);
  });
});

describe("chapter 3's Quantity arithmetic", () => {
  test.each([
    ['5 kg + 250 g', '5.250 kg'],
    ['90 min + 1 day', '1530 min'],
    ['500 mi / 4 hr', '125 mi/hr'],
    ['(500 mi / 4 hr) as km/hr', '201.168 km/hr'],
    ['2 m * 3 ft', '1.8288 m^2'],
    ['2 m * 3 s', '6 m*s'],
    ['3 kg * 2 m', '6 kg*m'],
    ['4 L / 2 m', '2 L/m'],
    ['2 L * 2 L', '4 L^2'],
    ['1 / 2 s', '0.5 1/s'],
    ['10 USD / 2 EUR', '5 USD/EUR'],
    ['100 EUR * 1.1 USD/EUR', '110.0 USD'],
    ['60 mi/hr * 2 hr', '120.0 mi'],
    ['9 degF as degC', '5 degC'],
    ['24 m^3 as L', '24000 L'],
    ['4 yd / 2 ft', '6'],
    ['3 kg * 2', '6 kg'],
    ['-(3 kg)', '-3 kg'],
    ['(3 m) ^ 2', '9 m^2'],
    ['1 year as months', '12 months'],
    ['"5 kg" as g', '5000 g'],
    ['" 60 mi/hr " as km/hr', '96.56064 km/hr'],
    ['"5" as kg', '5 kg'],
    ['3 as kg', '3 kg'],
  ])('%s is %s', (expr, expected) => {
    expect(value(expr)).toBe(expected);
  });

  test.each([
    [
      '5 kg + 3',
      'error code: "wrong kind", expected: "quantity", got: "number", value: 3',
    ],
    [
      '3 + 5 kg',
      'error code: "wrong kind", expected: "number", got: "quantity", value: 5 kg',
    ],
    ['5 kg + 2 m', 'error code: "incompatible units", left: "kg", right: "m"'],
    [
      '1 month + 1 day',
      'error code: "incompatible units", left: "month", right: "day"',
    ],
    [
      '2 month * 2 month',
      'error code: "incompatible units", left: "month", right: "month"',
    ],
    [
      '1 / 2 month',
      'error code: "incompatible units", left: "1", right: "month"',
    ],
    [
      '(1 month) ^ 2',
      'error code: "incompatible units", left: "month", right: "1"',
    ],
    [
      '(3 m) ^ 0',
      'error code: "wrong kind", expected: "integer", got: "number", value: 0',
    ],
    [
      '(3 m) ^ 1.5',
      'error code: "wrong kind", expected: "integer", got: "number", value: 1.5',
    ],
    [
      '2 ^ (3 m)',
      'error code: "wrong kind", expected: "number", got: "quantity", value: 3 m',
    ],
    [
      '5 kg div 2',
      'error code: "wrong kind", expected: "number", got: "quantity", value: 5 kg',
    ],
    [
      '7 mod 2 kg',
      'error code: "wrong kind", expected: "number", got: "quantity", value: 2 kg',
    ],
    [
      '5 kg as number',
      'error code: "can\'t convert", value: 5 kg, to: "number"',
    ],
    [
      '"5 kg" as number',
      'error code: "can\'t convert", value: "5 kg", to: "number"',
    ],
    ['5 kg as m', 'error code: "can\'t convert", value: 5 kg, to: "m"'],
    [
      '1 day as months',
      'error code: "can\'t convert", value: 1 day, to: "month"',
    ],
    ['"lots" as kg', 'error code: "can\'t convert", value: "lots", to: "kg"'],
    [
      '"5 parsec" as kg',
      'error code: "can\'t convert", value: "5 parsec", to: "kg"',
    ],
    [
      '9999999999999999999999999999999999 km as mm',
      'error code: "can\'t convert", value: 9999999999999999999999999999999999 km, to: "mm"',
    ],
    ['5 kg < 5 m', 'error code: "can\'t compare", left: 5 kg, right: 5 m'],
    ['1 m..2 kg', 'error code: "incompatible units", left: "m", right: "kg"'],
    [
      '1 m..2',
      'error code: "wrong kind", expected: "quantity", got: "number", value: 2',
    ],
  ])('%s raises', (expr, expected) => {
    expect(value(expr)).toBe(expected);
  });

  test('equality, ordering and membership are in Base Units', () => {
    expect(value('5 kg = 5000 g')).toBe('true');
    expect(value('1 L = 1000 mL')).toBe('true');
    expect(value('5 kg = 5 m')).toBe('false');
    expect(value('5 = 5 kg')).toBe('false');
    expect(value('1 month = 30 days')).toBe('false');
    expect(value('1200 g > 1 kg')).toBe('true');
    expect(value('1.5 kg is in 1 kg..2000 g')).toBe('true');
    expect(value('max([1 kg, 1200 g, 900 g])')).toBe('1200 g');
    expect(value('5 kg is a quantity')).toBe('true');
    expect(value('"5 kg" can be g')).toBe('true');
    expect(value('5 kg can be m')).toBe('false');
  });

  test('the number Built-ins keep a Quantity’s Unit', () => {
    expect(value('round(2.567 kg, 2)')).toBe('2.57 kg');
    expect(value('abs(-2 kg)')).toBe('2 kg');
    expect(value('floor(-2.5 m)')).toBe('-3 m');
    expect(value('ceiling(2.1 s)')).toBe('3 s');
    expect(value('truncate(-2.9 days)')).toBe('-2 days');
  });

  test('a Quantity is text by its display form', () => {
    expect(value('5 kg & ""')).toBe('"5 kg"');
    expect(value('(1 m..2 m) & ""')).toBe('"1 m..2 m"');
  });
});

test('`digits` counts a Quantity’s number, and a Quantity is 24 bytes', () => {
  const q = quantity(dec('5.250'), 'kg');
  expect(charge(rateOf('arithmetic'), { result: q })).toEqual({
    fuel: 4,
    alloc: 24,
  });
});
