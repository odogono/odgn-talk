// Instants as epoch nanoseconds, and their display form (chapter 3, Date
// text): `2026-09-27T13:30:00Z`, with a fraction only when it isn't zero.
import { invalidValue } from './errors';

const NS_PER_DAY = 86_400_000_000_000n;

// Days since 1970-01-01 of a proleptic Gregorian date (Hinnant's algorithm).
const daysFromCivil = (y: number, m: number, d: number): number => {
  const year = m <= 2 ? y - 1 : y;
  const era = Math.floor(year / 400);
  const yoe = year - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
};
const civilFromDays = (z: number): [number, number, number] => {
  const shifted = z + 719_468;
  const era = Math.floor(shifted / 146_097);
  const doe = shifted - era * 146_097;
  const yoe = Math.floor(
    (doe -
      Math.floor(doe / 1460) +
      Math.floor(doe / 36_524) -
      Math.floor(doe / 146_096)) /
      365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
};
const daysIn = (y: number, m: number) =>
  [
    31,
    y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][m - 1]!;

/** An Instant's display form, read as epoch nanoseconds. */
export const parseInstant = (s: string): bigint => {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(
      s,
    );
  if (!m) {
    invalidValue(`Not an Instant: ${s}`);
  }
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number) as number[];
  if (
    mo! < 1 ||
    mo! > 12 ||
    d! < 1 ||
    d! > daysIn(y!, mo!) ||
    h! > 23 ||
    mi! > 59 ||
    sec! > 59
  ) {
    invalidValue(`Not an Instant: ${s}`);
  }
  const fraction = BigInt((m[7] ?? '').padEnd(9, '0'));
  return (
    BigInt(daysFromCivil(y!, mo!, d!)) * NS_PER_DAY +
    BigInt(h! * 3600 + mi! * 60 + sec!) * 1_000_000_000n +
    fraction
  );
};

/** Epoch nanoseconds in an Instant's display form. */
export const formatInstant = (ns: bigint): string => {
  let days = ns / NS_PER_DAY;
  let rest = ns % NS_PER_DAY;
  if (rest < 0n) {
    rest += NS_PER_DAY;
    days -= 1n;
  }
  const [y, m, d] = civilFromDays(Number(days));
  const seconds = Number(rest / 1_000_000_000n);
  const fraction = (rest % 1_000_000_000n)
    .toString()
    .padStart(9, '0')
    .replace(/0+$/, '');
  const two = (n: number) => String(n).padStart(2, '0');
  return `${String(y).padStart(4, '0')}-${two(m)}-${two(d)}T${two(Math.floor(seconds / 3600))}:${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}${fraction ? `.${fraction}` : ''}Z`;
};
