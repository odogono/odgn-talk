import { describe, expect, test } from 'bun:test';
import { compileSource } from '../src/lowering';
import { deliver, loadScript } from '../src/machine';
import {
  civilDate,
  decodeValue,
  encodeValue,
  formatInstant,
  HostError,
  instant,
  parseInstant,
  readDisplay,
} from '../src/index';
import {
  civilFromDays,
  daysFromCivil,
  isoWeek,
  weekday,
  type CivilRef,
} from '../src/dates';

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
const c = (s: string) => `("${s}" as civil date)`;
const i = (s: string) => `("${s}" as instant)`;
const date = (y: number, m: number, d: number): CivilRef => ({
  year: y,
  month: m,
  day: d,
  ns: null,
});

describe('the calendar', () => {
  test('day numbers round-trip across the whole range', () => {
    expect(daysFromCivil(1970n, 1, 1)).toBe(0n);
    expect(daysFromCivil(1n, 1, 1)).toBe(-719_162n);
    expect(daysFromCivil(9999n, 12, 31)).toBe(2_932_896n);
    for (let z = -719_162n; z <= 2_932_896n; z += 997n) {
      const [y, m, d] = civilFromDays(z);
      expect(daysFromCivil(y, m, d)).toBe(z);
    }
  });

  test('ISO 8601 weekdays and weeks', () => {
    expect(weekday(date(2026, 9, 27))).toBe(7);
    expect(weekday(date(1, 1, 1))).toBe(1);
    expect(isoWeek(date(2021, 1, 3))).toEqual({ year: 2020, week: 53 });
    expect(isoWeek(date(2024, 12, 30))).toEqual({ year: 2025, week: 1 });
    expect(isoWeek(date(2026, 1, 1))).toEqual({ year: 2026, week: 1 });
    expect(isoWeek(date(2026, 12, 31))).toEqual({ year: 2026, week: 53 });
  });
});

describe('Host values', () => {
  test('constructors refuse dates that do not exist or are out of range', () => {
    expect(civilDate({ year: 2026, month: 9, day: 27 }).toString()).toBe(
      '2026-09-27',
    );
    expect(
      civilDate({
        year: 2026,
        month: 9,
        day: 27,
        hour: 14,
        minute: 30,
        nanosecond: 500_000_000,
      }).toString(),
    ).toBe('2026-09-27T14:30:00.5');
    expect(civilDate('2024-02-29').asCivilDate()).toEqual({
      year: 2024,
      month: 2,
      day: 29,
    });
    expect(civilDate('2026-09-27T01:02:03.000000004').asCivilDate()).toEqual({
      year: 2026,
      month: 9,
      day: 27,
      hour: 1,
      minute: 2,
      second: 3,
      nanosecond: 4,
    });
    for (const bad of [
      { year: 2026, month: 2, day: 29 },
      { year: 0, month: 1, day: 1 },
      { year: 2026, month: 13, day: 1 },
      { year: 2026, month: 1, day: 1, hour: 24 },
      { year: 2026, month: 1, day: 1.5 },
    ]) {
      expect(() => civilDate(bad)).toThrow(HostError);
    }
    for (const bad of [
      '2026-9-27',
      '2026-09-27Z',
      '0000-01-01',
      '2026-09-27T14:30',
    ]) {
      expect(() => civilDate(bad)).toThrow(HostError);
    }
    expect(instant(0n).toString()).toBe('1970-01-01T00:00:00Z');
    expect(instant(-1n).toString()).toBe('1969-12-31T23:59:59.999999999Z');
    expect(instant(5n).asInstant()).toBe(5n);
    expect(() => instant(0 as unknown as bigint)).toThrow(HostError);
    expect(() =>
      instant(parseInstant('9999-12-31T23:59:59.999999999Z') + 1n),
    ).toThrow(HostError);
    expect(formatInstant(parseInstant('0001-01-01T00:00:00Z'))).toBe(
      '0001-01-01T00:00:00Z',
    );
  });

  test('the display form and Value Encoding round-trip', () => {
    for (const [display, encoding] of [
      ['2026-09-27', '{"$date":"2026-09-27"}'],
      ['2026-09-27T14:30:00', '{"$date":"2026-09-27T14:30:00"}'],
      ['2026-09-27T14:30:00.5', '{"$date":"2026-09-27T14:30:00.5"}'],
      ['2026-09-27T13:30:00Z', '{"$instant":"2026-09-27T13:30:00Z"}'],
      [
        '2026-09-27T13:30:00.000000001Z',
        '{"$instant":"2026-09-27T13:30:00.000000001Z"}',
      ],
      [
        '[2026-09-27, {at: 2026-09-27T13:30:00Z}]',
        '[{"$date":"2026-09-27"},{"at":{"$instant":"2026-09-27T13:30:00Z"}}]',
      ],
    ] as const) {
      const v = readDisplay(display);
      expect(v.toString()).toBe(display);
      expect(encodeValue(v)).toBe(encoding);
      expect(decodeValue(encoding, () => null).toString()).toBe(display);
    }
  });

  test('readers refuse dates not in their display form', () => {
    for (const display of [
      '2026-09-27T14:30:00.50',
      '2026-02-30',
      '2026-09-27T14:30:00+01:00',
      '2026-09-27T',
    ]) {
      expect(() => readDisplay(display)).toThrow(HostError);
    }
    for (const encoding of [
      '{"$instant":"2026-09-27T13:30:00"}',
      '{"$instant":"2026-09-27T14:30:00+01:00"}',
      '{"$date":"2026-09-27T13:30:00Z"}',
      '{"$date":"2026-09-27T13:30:00.10"}',
    ]) {
      expect(() => decodeValue(encoding, () => null)).toThrow(HostError);
    }
  });
});

describe("chapter 3's date arithmetic", () => {
  test.each([
    [`${i('2026-09-28T10:00:00+01:00')}`, '2026-09-28T09:00:00Z'],
    [`${i('2026-09-28T10:00:00+01:00')} + 90 min`, '2026-09-28T10:30:00Z'],
    [`${c('2026-01-31')} + 1 month`, '2026-02-28'],
    [`${c('2024-01-31')} + 1 month`, '2024-02-29'],
    [`${c('2026-01-31')} + 13 months`, '2027-02-28'],
    [`${c('2026-03-31')} - 1 month`, '2026-02-28'],
    [`${c('2026-01-31')} + 0.5 year`, '2026-07-31'],
    [`${c('2026-01-31T09:15:00')} + 1 year`, '2027-01-31T09:15:00'],
    [`${c('2026-01-31')} + 2 days`, '2026-02-02'],
    [`${c('2026-01-31')} + 48 hr`, '2026-02-02'],
    [`${c('2026-01-31')} - 1 day`, '2026-01-30'],
    [`${c('2026-09-27T23:30:00')} + 1 hr`, '2026-09-28T00:30:00'],
    [`${c('2026-09-27T14:30:00')} + 1.5 s`, '2026-09-27T14:30:01.5'],
    [`${c('2026-09-27T14:30:00')} + 0.0000000005 s`, '2026-09-27T14:30:00'],
    [
      `${c('2026-09-27T14:30:00')} + 0.0000000015 s`,
      '2026-09-27T14:30:00.000000002',
    ],
    [`${i('2026-09-28T09:00:00Z')} - ${i('2026-09-28T08:58:30Z')}`, '90 s'],
    [
      `${i('2026-09-28T09:00:00Z')} - ${i('2026-09-28T09:00:00.25Z')}`,
      '-0.25 s',
    ],
    [`${i('2026-09-28T09:00:00Z')} - ${i('2026-09-28T09:00:00Z')}`, '0 s'],
    [`${c('2026-09-27T14:30:00')} - ${c('2026-09-27T14:29:58.5')}`, '1.5 s'],
    [`${c('2026-01-31')} - ${c('2026-01-01')}`, '30 days'],
    [`${c('2026-01-01')} - ${c('2026-01-02')}`, '-1 day'],
  ])('%s is %s', (expr, expected) => {
    expect(value(expr)).toBe(expected);
  });

  test.each([
    [
      `${i('2026-09-28T09:00:00Z')} + 1 month`,
      'error code: "incompatible units", left: "s", right: "month"',
    ],
    [
      `${c('2026-01-31')} + 36 hr`,
      'error code: "incompatible units", left: "day", right: "hr"',
    ],
    [
      `${c('2026-01-31')} + 1.5 month`,
      'error code: "incompatible units", left: "month", right: "month"',
    ],
    [
      `${c('2026-01-31T00:00:00')} + 5 kg`,
      'error code: "incompatible units", left: "s", right: "kg"',
    ],
    [
      `${i('2026-09-28T09:00:00Z')} + 5`,
      'error code: "wrong kind", expected: "quantity", got: "number", value: 5',
    ],
    [
      `${i('2026-09-28T09:00:00Z')} + ${i('2026-09-28T09:00:00Z')}`,
      'error code: "wrong kind", expected: "quantity", got: "instant", value: 2026-09-28T09:00:00Z',
    ],
    [
      `${i('2026-09-28T09:00:00Z')} - ${c('2026-09-28')}`,
      'error code: "wrong kind", expected: "instant", got: "civil date", value: 2026-09-28',
    ],
    [
      `${c('2026-09-28')} - ${c('2026-09-28T00:00:00')}`,
      'error code: "wrong kind", expected: "civil date", got: "civil date", value: 2026-09-28T00:00:00',
    ],
    [
      `5 s + ${i('2026-09-28T09:00:00Z')}`,
      'error code: "wrong kind", expected: "quantity", got: "instant", value: 2026-09-28T09:00:00Z',
    ],
    [
      `5 + ${c('2026-09-28')}`,
      'error code: "wrong kind", expected: "number", got: "civil date", value: 2026-09-28',
    ],
    [
      `${c('2026-09-28')} * 2`,
      'error code: "wrong kind", expected: "number", got: "civil date", value: 2026-09-28',
    ],
    [
      `-${c('2026-09-28')}`,
      'error code: "wrong kind", expected: "number", got: "civil date", value: 2026-09-28',
    ],
    [
      `${c('9999-12-31')} + 1 day`,
      'error code: "out of range", field: "year", value: 10000',
    ],
    [
      `${c('0001-01-01T00:00:00')} - 1 s`,
      'error code: "out of range", field: "year", value: 0',
    ],
    [
      `${i('9999-12-31T23:59:59Z')} + 1 s`,
      'error code: "out of range", field: "year", value: 10000',
    ],
  ])('%s raises', (expr, expected) => {
    expect(value(expr)).toBe(expected);
  });

  test('comparison: Instants by time, Civil Dates only against their own kind of date', () => {
    expect(
      value(`${i('2026-09-28T09:00:00Z')} < ${i('2026-09-28T09:00:00.1Z')}`),
    ).toBe('true');
    expect(
      value(`${i('2026-09-28T10:00:00+01:00')} = ${i('2026-09-28T09:00:00Z')}`),
    ).toBe('true');
    expect(value(`${c('2026-01-31')} < ${c('2026-02-01')}`)).toBe('true');
    expect(value(`${c('2026-01-31')} = ${c('2026-01-31T00:00:00')}`)).toBe(
      'false',
    );
    expect(value(`${c('2026-01-31')} < ${c('2026-01-31T00:00:00')}`)).toBe(
      'error code: "can\'t compare", left: 2026-01-31, right: 2026-01-31T00:00:00',
    );
    expect(
      value(`${i('2026-09-28T09:00:00Z')} < ${c('2026-01-31')}`),
    ).toStartWith('error code: "can\'t compare"');
    expect(
      value(
        `max([${c('2026-01-31')}, ${c('2026-03-01')}, ${c('2025-12-31')}])`,
      ),
    ).toBe('2026-03-01');
  });
});

describe('conversion', () => {
  test.each([
    ['" 2026-09-27 " as civil date', '2026-09-27'],
    ['"2026-09-27T14:30:00.500" as civil date', '2026-09-27T14:30:00.5'],
    ['"2026-09-27T14:30:00-05:30" as instant', '2026-09-27T20:00:00Z'],
    [
      '"2026-09-27T14:30:00.123456789Z" as instant',
      '2026-09-27T14:30:00.123456789Z',
    ],
    [`${c('2026-09-27T14:30:00')} as text`, '"2026-09-27T14:30:00"'],
    [`${i('2026-09-27T14:30:00Z')} & ""`, '"2026-09-27T14:30:00Z"'],
    [`${c('2026-09-27')} as civil date`, '2026-09-27'],
    [`${i('2026-09-27T14:30:00Z')} is a instant`, 'true'],
    [`${c('2026-09-27')} is a civil date`, 'true'],
    ['"x" can be civil date', 'false'],
    ['"0000-01-01" can be civil date', 'false'],
  ])('%s is %s', (expr, expected) => {
    expect(value(expr)).toBe(expected);
  });

  test.each([
    [
      '"2026-02-30" as civil date',
      'error code: "can\'t convert", value: "2026-02-30", to: "civil date"',
    ],
    [
      '"2026-09-27T14:30:60" as civil date',
      'error code: "can\'t convert", value: "2026-09-27T14:30:60", to: "civil date"',
    ],
    [
      '"2026-09-27Z" as civil date',
      'error code: "can\'t convert", value: "2026-09-27Z", to: "civil date"',
    ],
    [
      '"2026-09-27T14:30:00" as instant',
      'error code: "can\'t convert", value: "2026-09-27T14:30:00", to: "instant"',
    ],
    [
      '"2026-09-27" as instant',
      'error code: "can\'t convert", value: "2026-09-27", to: "instant"',
    ],
    [
      '"2026-09-27T14:30:00+24:00" as instant',
      'error code: "can\'t convert", value: "2026-09-27T14:30:00+24:00", to: "instant"',
    ],
    [
      '"2026-09-27T14:30:00.1234567890Z" as instant',
      'error code: "can\'t convert", value: "2026-09-27T14:30:00.1234567890Z", to: "instant"',
    ],
    [
      '"0000-01-01" as civil date',
      'error code: "out of range", field: "year", value: 0',
    ],
    [
      '"0001-01-01T00:30:00+01:00" as instant',
      'error code: "out of range", field: "year", value: 0',
    ],
    [
      `${i('2026-09-27T14:30:00Z')} as civil date`,
      'error code: "can\'t convert", value: 2026-09-27T14:30:00Z, to: "civil date"',
    ],
    ['5 as instant', 'error code: "can\'t convert", value: 5, to: "instant"'],
  ])('%s raises', (expr, expected) => {
    expect(value(expr)).toBe(expected);
  });
});

describe('the date Built-ins', () => {
  const d = c('2026-09-27T14:30:05.25');
  test.each([
    [`year(${d})`, '2026'],
    [`month(${d})`, '9'],
    [`day(${d})`, '27'],
    [`hour(${d})`, '14'],
    [`minute(${d})`, '30'],
    [`second(${d})`, '5'],
    [`nanosecond(${d})`, '250000000'],
    [`weekday(${d})`, '7'],
    [`dayOfYear(${c('2024-12-31')})`, '366'],
    [`isoWeek(${c('2021-01-03')})`, '53'],
    [`isoWeekYear(${c('2021-01-03')})`, '2020'],
    [`hasTime(${d})`, 'true'],
    [`hasTime(${c('2026-09-27')})`, 'false'],
    [`toCivil(${i('2026-09-28T09:00:00Z')}, 0 s)`, '2026-09-28T09:00:00'],
    [`toCivil(${i('2026-09-28T09:00:00Z')}, 90 min)`, '2026-09-28T10:30:00'],
    [`toCivil(${i('2026-09-28T09:00:00Z')}, -5.5 hr)`, '2026-09-28T03:30:00'],
    [`toInstant(${c('2026-09-27T14:30:00')}, 1 hr)`, '2026-09-27T13:30:00Z'],
    [`toInstant(${c('2026-09-27T14:30:00')}, -23 hr)`, '2026-09-28T13:30:00Z'],
  ])('%s is %s', (expr, expected) => {
    expect(value(expr)).toBe(expected);
  });

  test.each([
    [
      `hour(${c('2026-09-27')})`,
      'error code: "out of domain", function: "hour", value: 2026-09-27',
    ],
    [
      `nanosecond(${c('2026-09-27')})`,
      'error code: "out of domain", function: "nanosecond", value: 2026-09-27',
    ],
    [
      `year(${i('2026-09-28T09:00:00Z')})`,
      'error code: "wrong kind", expected: "civil date", got: "instant", value: 2026-09-28T09:00:00Z',
    ],
    [
      `toCivil(${i('2026-09-28T09:00:00Z')}, 30 s)`,
      'error code: "out of domain", function: "toCivil", value: 30 s',
    ],
    [
      `toCivil(${i('2026-09-28T09:00:00Z')}, 24 hr)`,
      'error code: "out of domain", function: "toCivil", value: 24 hr',
    ],
    [
      `toCivil(${i('2026-09-28T09:00:00Z')}, 0)`,
      'error code: "out of domain", function: "toCivil", value: 0',
    ],
    [
      `toCivil(${i('2026-09-28T09:00:00Z')}, 1 month)`,
      'error code: "out of domain", function: "toCivil", value: 1 month',
    ],
    [
      `toCivil(${c('2026-09-28')}, 0 s)`,
      'error code: "wrong kind", expected: "instant", got: "civil date", value: 2026-09-28',
    ],
    [
      `toInstant(${c('2026-09-27')}, 0 s)`,
      'error code: "out of domain", function: "toInstant", value: 2026-09-27',
    ],
    [
      `toCivil(${i('9999-12-31T23:30:00Z')}, 1 hr)`,
      'error code: "out of range", field: "year", value: 10000',
    ],
    [
      `toInstant(${c('0001-01-01T00:30:00')}, 1 hr)`,
      'error code: "out of range", field: "year", value: 0',
    ],
  ])('%s raises', (expr, expected) => {
    expect(value(expr)).toBe(expected);
  });
});
