// Instants and Civil Dates (chapter 3, Dates and times): the proleptic
// Gregorian calendar, the ISO 8601 text forms, and the range 0001-01-01 to
// 9999-12-31. Every day is 86400 s long, and there is no time-zone data.
// Calendar arithmetic is BigInt, so a result far out of range still names its
// exact year.

import { invalidValue } from './errors';

export const NS_PER_SECOND = 1_000_000_000n;
export const NS_PER_DAY = 86_400n * NS_PER_SECOND;

/** A Civil Date: a date, and a time of day as nanoseconds since midnight, or null. */
export type CivilRef = {
  readonly day: number;
  readonly month: number;
  /** Nanoseconds since midnight, for a date-time; null for a date-only value. */
  readonly ns: bigint | null;
  readonly year: number;
};

/** A date or time past the range; `year` is the year it would have been. */
export class DateRangeError extends Error {
  override name = 'DateRangeError';
  constructor(readonly year: bigint) {
    super(`the year ${year} is outside 1 to 9999`);
  }
}

const floorDiv = (a: bigint, b: bigint) => {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
};

// Days since 1970-01-01 of a proleptic Gregorian date (Hinnant's algorithm).
export const daysFromCivil = (y: bigint, m: number, d: number): bigint => {
  const year = m <= 2 ? y - 1n : y;
  const era = floorDiv(year, 400n);
  const yoe = year - era * 400n;
  const doy = BigInt(
    Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1,
  );
  const doe = yoe * 365n + yoe / 4n - yoe / 100n + doy;
  return era * 146_097n + doe - 719_468n;
};
export const civilFromDays = (z: bigint): [bigint, number, number] => {
  const shifted = z + 719_468n;
  const era = floorDiv(shifted, 146_097n);
  const doe = shifted - era * 146_097n;
  const yoe = (doe - doe / 1460n + doe / 36_524n - doe / 146_096n) / 365n;
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n);
  const mp = (5n * doy + 2n) / 153n;
  const d = Number(doy - (153n * mp + 2n) / 5n + 1n);
  const m = Number(mp + (mp < 10n ? 3n : -9n));
  return [yoe + era * 400n + (m <= 2 ? 1n : 0n), m, d];
};
const isLeap = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
export const daysIn = (y: number, m: number) =>
  [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;

const inRange = (year: bigint): number => {
  if (year < 1n || year > 9999n) {
    throw new DateRangeError(year);
  }
  return Number(year);
};

/** The Civil Date of a day number and an optional time of day, in range. */
export const civilOfDays = (days: bigint, ns: bigint | null): CivilRef => {
  const [y, month, day] = civilFromDays(days);
  return { year: inRange(y), month, day, ns };
};
/** A Civil Date's day number since 1970-01-01. */
export const civilDays = (c: CivilRef): bigint =>
  daysFromCivil(BigInt(c.year), c.month, c.day);
/** A date-time as nanoseconds on a timeline with every day 86400 s long. */
export const civilNs = (c: CivilRef): bigint =>
  civilDays(c) * NS_PER_DAY + (c.ns ?? 0n);
export const civilOfNs = (ns: bigint): CivilRef => {
  const days = floorDiv(ns, NS_PER_DAY);
  return civilOfDays(days, ns - days * NS_PER_DAY);
};
/** An Instant, as epoch nanoseconds, checked against the range in UTC. */
export const checkInstant = (ns: bigint): bigint => {
  civilOfNs(ns);
  return ns;
};

const whole = (n: unknown) => typeof n === 'number' && Number.isInteger(n);

/** A Civil Date from its fields, or a reason it isn't one. */
export const civilFromFields = (f: {
  day: number;
  hour?: number;
  minute?: number;
  month: number;
  nanosecond?: number;
  second?: number;
  year: number;
}): CivilRef | string => {
  if (![f.year, f.month, f.day].every(whole)) {
    return 'a year, month and day are integers';
  }
  if (f.month < 1 || f.month > 12) {
    return 'a month is from 1 to 12';
  }
  if (f.year < 1 || f.year > 9999) {
    return 'a year is from 1 to 9999';
  }
  if (f.day < 1 || f.day > daysIn(f.year, f.month)) {
    return `that month has no day ${f.day}`;
  }
  const time = [f.hour, f.minute, f.second, f.nanosecond];
  if (time.every(t => t === undefined)) {
    return { year: f.year, month: f.month, day: f.day, ns: null };
  }
  const [h = 0, mi = 0, s = 0, n = 0] = time;
  if (
    ![h, mi, s, n].every(whole) ||
    h < 0 ||
    h > 23 ||
    mi < 0 ||
    mi > 59 ||
    s < 0 ||
    s > 59 ||
    n < 0 ||
    n > 999_999_999
  ) {
    return 'a time of day is from 00:00:00 to 23:59:59.999999999';
  }
  return {
    year: f.year,
    month: f.month,
    day: f.day,
    ns: BigInt(h * 3600 + mi * 60 + s) * NS_PER_SECOND + BigInt(n),
  };
};

/** A Civil Date's fields, as the Host reads them. */
export const civilFields = (c: CivilRef) => {
  const base = { year: c.year, month: c.month, day: c.day };
  if (c.ns === null) {
    return base;
  }
  const seconds = Number(c.ns / NS_PER_SECOND);
  return {
    ...base,
    hour: Math.floor(seconds / 3600),
    minute: Math.floor(seconds / 60) % 60,
    second: seconds % 60,
    nanosecond: Number(c.ns % NS_PER_SECOND),
  };
};

const two = (n: number) => String(n).padStart(2, '0');
const timeText = (ns: bigint) => {
  const seconds = Number(ns / NS_PER_SECOND);
  const fraction = (ns % NS_PER_SECOND)
    .toString()
    .padStart(9, '0')
    .replace(/0+$/, '');
  return `${two(Math.floor(seconds / 3600))}:${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}${fraction ? `.${fraction}` : ''}`;
};
const dateText = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, '0')}-${two(m)}-${two(d)}`;

/** A Civil Date's text form: `2026-09-27`, or `2026-09-27T14:30:00.5`. */
export const civilText = (c: CivilRef): string =>
  dateText(c.year, c.month, c.day) +
  (c.ns === null ? '' : `T${timeText(c.ns)}`);

/** An Instant's text form, always in UTC: `2026-09-27T13:30:00Z`. */
export const formatInstant = (ns: bigint): string => {
  const days = floorDiv(ns, NS_PER_DAY);
  const [y, m, d] = civilFromDays(days);
  return `${dateText(Number(y), m, d)}T${timeText(ns - days * NS_PER_DAY)}Z`;
};

const civilPattern =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?)?/;

// The date and time a text starts with, and the rest; undefined when the
// fields don't name a date and time that exist. Year 0 is a range error.
const readCivil = (s: string): { c: CivilRef; rest: string } | undefined => {
  const m = civilPattern.exec(s);
  if (!m) {
    return undefined;
  }
  const [y, mo, d] = m.slice(1, 4).map(Number) as [number, number, number];
  if (y === 0 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(4, mo)) {
    throw new DateRangeError(0n);
  }
  const fields =
    m[4] === undefined
      ? { year: y, month: mo, day: d }
      : {
          year: y,
          month: mo,
          day: d,
          hour: Number(m[4]),
          minute: Number(m[5]),
          second: Number(m[6]),
          nanosecond: Number((m[7] ?? '').padEnd(9, '0')),
        };
  const c = civilFromFields(fields);
  return typeof c === 'string' ? undefined : { c, rest: s.slice(m[0].length) };
};

/** `as civil date`: exactly the text form, or undefined. Throws DateRangeError for year 0. */
export const parseCivil = (s: string): CivilRef | undefined => {
  const read = readCivil(s);
  return read && read.rest === '' ? read.c : undefined;
};

/**
 * `as instant`: a date-time, then `Z` or a numeric offset of less than 24
 * hours, converted to UTC; or undefined. Throws DateRangeError past the range.
 */
export const parseInstantText = (s: string): bigint | undefined => {
  const read = readCivil(s);
  if (!read || read.c.ns === null) {
    return undefined;
  }
  let offset = 0n;
  if (read.rest !== 'Z') {
    const m = /^([+-])(\d{2}):(\d{2})$/.exec(read.rest);
    if (!m || Number(m[3]) > 59 || Number(m[2]) > 23) {
      return undefined;
    }
    offset =
      (m[1] === '-' ? -1n : 1n) *
      BigInt(Number(m[2]) * 3600 + Number(m[3]) * 60) *
      NS_PER_SECOND;
  }
  return checkInstant(civilNs(read.c) - offset);
};

/** An Instant's display form as epoch nanoseconds, for the Host and the Trace. */
export const parseInstant = (s: string): bigint => {
  let ns: bigint | undefined;
  try {
    ns = s.endsWith('Z') ? parseInstantText(s) : undefined;
  } catch (error) {
    if (!(error instanceof DateRangeError)) {
      throw error;
    }
  }
  return ns ?? invalidValue(`Not an Instant: ${s}`);
};

/** Months since year 0, and back, for calendar arithmetic. */
export const addMonths = (c: CivilRef, months: bigint): CivilRef => {
  const total = BigInt(c.year) * 12n + BigInt(c.month - 1) + months;
  const year = floorDiv(total, 12n);
  const month = Number(total - year * 12n) + 1;
  const y = inRange(year);
  return { year: y, month, day: Math.min(c.day, daysIn(y, month)), ns: c.ns };
};

/** ISO 8601: 1 for Monday to 7 for Sunday. 1970-01-01 was a Thursday. */
export const weekday = (c: CivilRef): number =>
  Number(((civilDays(c) % 7n) + 10n) % 7n) + 1;
export const dayOfYear = (c: CivilRef): number =>
  Number(civilDays(c) - daysFromCivil(BigInt(c.year), 1, 1)) + 1;
/** ISO 8601 week numbering: the week with the year's first Thursday is week 1. */
export const isoWeek = (c: CivilRef): { week: number; year: number } => {
  const thursday = civilDays(c) - BigInt(weekday(c)) + 4n;
  const [y] = civilFromDays(thursday);
  const week = Number((thursday - daysFromCivil(y, 1, 1)) / 7n) + 1;
  return { year: Number(y), week };
};
