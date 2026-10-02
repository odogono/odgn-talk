import { expect, test } from 'bun:test';
import {
  civilDate,
  instant,
  parseInstant,
  readDisplay,
  text,
} from '@odgn/northtalk';
import { calendar, locale } from '../src/builtins';

const call = (binding: string, now = '2026-03-29T00:30:00Z') =>
  ({ binding, now: parseInstant(now), id: 'c' }) as never;
const london = call('Europe/London');
const at = (s: string) => instant(parseInstant(s));
const instantOf = (civil: string, how: string) =>
  calendar.toInstant(london, civilDate(civil), how).toString();
const failure = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    const e = error as { code: string; data: { toString(): string } };
    return `${e.code} ${e.data.toString()}`;
  }
  return 'no failure';
};

test('calendar reads wall clocks and offsets in a zone', () => {
  expect(calendar.zone(london).toString()).toBe('"Europe/London"');
  expect(calendar.zone(london, 'UTC').toString()).toBe('"UTC"');
  expect(calendar.today(london).toString()).toBe('2026-03-29');
  expect(calendar.now(london).toString()).toBe('2026-03-29T00:30:00');
  expect(
    calendar.toCivil(london, at('2026-07-01T00:00:00.25Z')).toString(),
  ).toBe('2026-07-01T01:00:00.25');
  expect(calendar.offset(london, at('2026-07-01T00:00:00Z')).toString()).toBe(
    '3600 s',
  );
  expect(failure(() => calendar.zone(london, 'Nowhere/X'))).toBe(
    'unknown zone {zone: "Nowhere/X"}',
  );
});

test('calendar moves a time in a gap forward, and takes the earlier one in an overlap', () => {
  // 01:30 doesn't exist on 2026-03-29, and happens twice on 2026-10-25.
  expect(instantOf('2026-03-29T01:30:00', 'compatible')).toBe(
    '2026-03-29T01:30:00Z',
  );
  expect(instantOf('2026-03-29T01:30:00', 'earlier')).toBe(
    '2026-03-29T00:30:00Z',
  );
  expect(instantOf('2026-10-25T01:30:00', 'compatible')).toBe(
    '2026-10-25T00:30:00Z',
  );
  expect(instantOf('2026-10-25T01:30:00', 'later')).toBe(
    '2026-10-25T01:30:00Z',
  );
  expect(instantOf('2026-06-01T12:00:00', 'reject')).toBe(
    '2026-06-01T11:00:00Z',
  );
  expect(
    failure(() =>
      calendar.toInstant(london, civilDate('2026-10-25T01:30:00'), 'reject'),
    ),
  ).toBe('ambiguous time {civil: 2026-10-25T01:30:00, zone: "Europe/London"}');
});

test('locale falls back by lookup to und, and collates, ranks and maps case', () => {
  const und = call('und');
  expect(locale.tag(call('xx-YY')).toString()).toBe('"und"');
  expect(locale.tag(und, 'fr-CA').toString()).toBe('"fr-CA"');
  const base = readDisplay('{sensitivity: "base", numeric: true}');
  expect(
    locale.compare(und, text('file 10'), text('file 9'), base).toString(),
  ).toBe('1');
  expect(
    locale.rank(und, readDisplay('["b", "a", "A", "b"]'), base).toString(),
  ).toBe('{a: 1, A: 1, b: 2}');
  expect(locale.upper(call('tr'), text('i')).toString()).toBe('"İ"');
  expect(locale.numberSymbols(call('de')).toString()).toContain(
    'decimal: ",", group: "."',
  );
  expect(
    locale
      .monthNames(call('de'), readDisplay('{width: "long", form: "format"}'))
      .toString(),
  ).toStartWith('["Januar", "Februar", "März"');
  expect(
    locale
      .dayNames(call('en'), readDisplay('{width: "short", form: "standalone"}'))
      .toString(),
  ).toBe('["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]');
});
