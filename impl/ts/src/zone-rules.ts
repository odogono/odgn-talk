// Zone Rules built from the runtime's own zone data, through `Intl` (chapter
// 9, Zone Rules builders; ADR 0179).
import { HostError } from './errors';
import {
  instant,
  list,
  num,
  quantity,
  record,
  text,
  type Value,
} from './values';

const SECOND = 1000;
// Offsets are sampled this far apart, and each change found by bisection, so
// two changes closer together than this that cancel out would be missed. No
// zone has changed its offset and back within six hours.
const STEP = 6 * 3600 * SECOND;

const formatIn = (zone: string): Intl.DateTimeFormat => {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    throw new HostError('invalid value', `zoneRules: unknown zone ${zone}`);
  }
};

/** The zone's offset from UTC at `ms`, a whole second, in seconds. */
const offsetAt = (format: Intl.DateTimeFormat, ms: number): number => {
  const parts: Record<string, string> = {};
  for (const p of format.formatToParts(new Date(ms))) {
    parts[p.type] = p.value;
  }
  const year = parts.era === 'BC' ? 1 - Number(parts.year) : Number(parts.year);
  const wall = new Date(0);
  wall.setUTCFullYear(year, Number(parts.month) - 1, Number(parts.day));
  wall.setUTCHours(
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (wall.getTime() - ms) / SECOND;
};

/** `ms` rounded down to a whole second. */
const second = (ms: number) => Math.floor(ms / SECOND) * SECOND;
const instantOfMs = (ms: number): Value => instant(BigInt(ms) * 1000n);

/**
 * Zone Rules for the IANA zone `zone` from `from` up to `until`, exclusive,
 * as an ordinary map (chapter 7): the offset in effect at `from`, then each
 * Instant in the window where the offset changes. An unknown zone, an empty
 * window, or an offset that isn't a whole number of minutes, as in local mean
 * time before a zone adopted standard time, throws invalid value.
 */
export const zoneRules = (zone: string, from: Date, until: Date): Value => {
  const start = from.getTime();
  const end = until.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new HostError('invalid value', 'zoneRules: an empty window');
  }
  const format = formatIn(zone);
  const offset = (ms: number) => {
    const o = offsetAt(format, second(ms));
    if (o % 60 !== 0) {
      throw new HostError(
        'invalid value',
        `zoneRules: ${zone} is ${o} s from UTC at ${new Date(ms).toISOString()}, not whole minutes`,
      );
    }
    return o;
  };
  const changes: Value[] = [];
  const change = (at: number, o: number) =>
    changes.push(
      record({ at: instantOfMs(at), offset: quantity(num(o), 's') }),
    );
  let current = offset(start);
  change(start, current);
  let at = start;
  const last = second(end - 1);
  while (at < last) {
    const next = Math.min(at + STEP, last);
    if (offset(next) === current) {
      at = next;
      continue;
    }
    // The first whole second in (at, next] with the new offset.
    let low = second(at);
    let high = next;
    while (high - low > SECOND) {
      const mid = second(low + (high - low) / 2);
      if (offset(mid) === current) {
        low = mid;
      } else {
        high = mid;
      }
    }
    current = offset(high);
    change(Math.max(high, start), current);
    at = high;
  }
  return record({
    zone: text(zone),
    until: instantOfMs(end),
    changes: list(...changes),
  });
};
