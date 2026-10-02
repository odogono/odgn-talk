// The REPL's built-in `calendar` and `locale` (chapter 7, Standard
// Capabilities), answered from the runtime's Intl data. Which zones and
// Locales a Host supports, and its answers, are its own and outside parity;
// a Session Transcript records each answer as a `~` line.
import {
  civilDate,
  instant,
  list,
  map,
  num,
  quantity,
  ScriptError,
  text,
  type CalendarImpl,
  type LocaleImpl,
  type Value,
} from '@odgn/northtalk';

const NS_PER_MS = 1_000_000n;
const NS_PER_S = 1_000_000_000n;
const DAY_NS = 86_400n * NS_PER_S;

// --------------------------------------------------------------- calendar

type Wall = {
  day: number;
  hour: number;
  minute: number;
  month: number;
  nanosecond: number;
  second: number;
  year: number;
};

const formats = new Map<string, Intl.DateTimeFormat>();
// The zone's wall-clock formatter, or `unknown zone`.
const formatIn = (zone: string): Intl.DateTimeFormat => {
  let f = formats.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      throw new ScriptError(
        'unknown zone',
        `unknown zone ${zone}`,
        map([['zone', text(zone)]]),
      );
    }
    formats.set(zone, f);
  }
  return f;
};

const floorDiv = (a: bigint, b: bigint) => {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
};

// The wall clock in the zone at an Instant.
const wallAt = (ns: bigint, zone: string): Wall => {
  const ms = floorDiv(ns, NS_PER_MS);
  const parts = Object.fromEntries(
    formatIn(zone)
      .formatToParts(new Date(Number(ms)))
      .map(p => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    nanosecond: Number(ns - floorDiv(ns, NS_PER_S) * NS_PER_S),
  };
};

// A wall clock read as if it were UTC, in epoch nanoseconds.
const asUtc = (w: Wall): bigint => {
  const d = new Date(0);
  d.setUTCFullYear(w.year, w.month - 1, w.day);
  d.setUTCHours(w.hour, w.minute, w.second, 0);
  return BigInt(d.getTime()) * NS_PER_MS + BigInt(w.nanosecond);
};

// The zone's offset from UTC at an Instant, in whole nanoseconds.
const offsetAt = (ns: bigint, zone: string): bigint =>
  asUtc(wallAt(ns, zone)) - ns;

const civilValue = (w: Wall, dateOnly = false): Value =>
  civilDate(dateOnly ? { year: w.year, month: w.month, day: w.day } : { ...w });

const sameWall = (a: Wall, b: Wall) =>
  a.year === b.year &&
  a.month === b.month &&
  a.day === b.day &&
  a.hour === b.hour &&
  a.minute === b.minute &&
  a.second === b.second &&
  a.nanosecond === b.nanosecond;

// The IANA id of the zone in use: the call's, or the Grant's.
const zoneOf = (call: { binding: string }, zone?: string) => {
  const id = zone ?? call.binding;
  return formatIn(id).resolvedOptions().timeZone;
};

export const calendar: CalendarImpl = {
  zone: (call, zone) => text(zoneOf(call, zone)),
  today: (call, zone) => civilValue(wallAt(call.now, zoneOf(call, zone)), true),
  now: (call, zone) => civilValue(wallAt(call.now, zoneOf(call, zone))),
  toCivil: (call, i, zone) =>
    civilValue(wallAt(i.asInstant()!, zoneOf(call, zone))),
  offset: (call, i, zone) => {
    const ns = offsetAt(i.asInstant()!, zoneOf(call, zone));
    return quantity(num(Number(ns / NS_PER_S)), 's');
  },
  // The Instants whose wall clock reads `c`: one, two in an overlap, or
  // none in a gap, which `compatible` and `later` move forward past.
  toInstant: (call, c, disambiguation, zone) => {
    const id = zoneOf(call, zone);
    const fields = c.asCivilDate() as Wall;
    const local = asUtc(fields);
    const before = offsetAt(local - DAY_NS, id);
    const after = offsetAt(local + DAY_NS, id);
    const found = [...new Set([local - before, local - after])]
      .filter(t => sameWall(wallAt(t, id), fields))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (found.length === 1) {
      return instant(found[0]!);
    }
    if (disambiguation === 'reject') {
      throw new ScriptError(
        'ambiguous time',
        `${c.toString()} is ambiguous in ${id}`,
        map([
          ['civil', c],
          ['zone', text(id)],
        ]),
      );
    }
    if (found.length === 2) {
      return instant(disambiguation === 'later' ? found[1]! : found[0]!);
    }
    // A gap: `earlier` reads the wall clock with the offset after it.
    const [small, large] = before < after ? [before, after] : [after, before];
    return instant(
      disambiguation === 'earlier' ? local - large : local - small,
    );
  },
};

// --------------------------------------------------------------- locale

// The Locale in use: the call's tag or the Grant's, falling back by lookup,
// dropping subtags from the right, down to the root Locale `und`.
const localeOf = (call: { binding: string }, tag?: string): string => {
  const requested = tag ?? call.binding;
  const subtags = requested.split('-');
  for (let n = subtags.length; n > 0; n--) {
    const candidate = subtags.slice(0, n).join('-');
    if (candidate.toLowerCase() === 'und') {
      break;
    }
    try {
      if (
        Intl.Collator.supportedLocalesOf([candidate], {
          localeMatcher: 'lookup',
        }).length
      ) {
        const resolved = new Intl.Collator(candidate).resolvedOptions().locale;
        if (resolved.toLowerCase() === candidate.toLowerCase()) {
          return resolved;
        }
      }
    } catch {
      // A tag Intl refuses falls back like an unsupported one.
    }
  }
  return 'und';
};
const intlTag = (locale: string) => (locale === 'und' ? [] : [locale]);

const word = (options: Value, key: string) => options.get(key).asText()!;

const collator = (locale: string, options: Value) =>
  new Intl.Collator(intlTag(locale), {
    sensitivity: word(
      options,
      'sensitivity',
    ) as Intl.CollatorOptions['sensitivity'],
    numeric: options.get('numeric').asBool() ?? false,
    usage: 'sort',
  });

const texts = (v: Value): string[] =>
  Array.from({ length: v.length }, (_, i) => v.index(i + 1).asText()!);

// A name from a date formatted with these options, for months and days.
const names = (
  locale: string,
  options: Value,
  field: 'month' | 'weekday',
  dates: Date[],
): Value => {
  const width = word(options, 'width') as 'long' | 'short' | 'narrow';
  const format = new Intl.DateTimeFormat(intlTag(locale), {
    timeZone: 'UTC',
    [field]: width,
    // The format form is the name as it reads inside a date.
    ...(word(options, 'form') === 'format' ? { day: 'numeric' } : {}),
  });
  return list(
    ...dates.map(d =>
      text(format.formatToParts(d).find(p => p.type === field)!.value),
    ),
  );
};

export const locale: LocaleImpl = {
  tag: (call, tag) => text(localeOf(call, tag)),
  compare: (call, a, b, options, tag) =>
    num(
      Math.sign(
        collator(localeOf(call, tag), options).compare(
          a.asText()!,
          b.asText()!,
        ),
      ),
    ),
  rank: (call, list, options, tag) => {
    const c = collator(localeOf(call, tag), options);
    const distinct = [...new Set(texts(list))].sort(c.compare);
    const ranks: [string, Value][] = [];
    let rank = 0;
    distinct.forEach((t, i) => {
      if (i === 0 || c.compare(distinct[i - 1]!, t) !== 0) {
        rank++;
      }
      ranks.push([t, num(rank)]);
    });
    return map(ranks);
  },
  upper: (call, s, tag) =>
    text(s.asText()!.toLocaleUpperCase(intlTag(localeOf(call, tag)))),
  lower: (call, s, tag) =>
    text(s.asText()!.toLocaleLowerCase(intlTag(localeOf(call, tag)))),
  numberSymbols: (call, tag) => {
    const l = intlTag(localeOf(call, tag));
    const part = (type: string) =>
      new Intl.NumberFormat(l, { useGrouping: true })
        .formatToParts(-1_234_567.5)
        .find(p => p.type === type)?.value ?? '';
    const groups = new Intl.NumberFormat(l, { useGrouping: true })
      .formatToParts(1_234_567_890)
      .filter(p => p.type === 'integer')
      .map(p => p.value.length);
    const plain = new Intl.NumberFormat(l, { useGrouping: false });
    return map([
      ['decimal', text(part('decimal'))],
      ['group', text(part('group'))],
      ['minus', text(part('minusSign'))],
      [
        'digits',
        list(...Array.from({ length: 10 }, (_, d) => text(plain.format(d)))),
      ],
      ['primaryGroup', num(groups.at(-1) ?? 3)],
      ['secondaryGroup', num(groups.at(-2) ?? groups.at(-1) ?? 3)],
      [
        'minGrouping',
        num(
          new Intl.NumberFormat(l)
            .formatToParts(1000)
            .some(p => p.type === 'group')
            ? 1
            : 2,
        ),
      ],
    ]);
  },
  monthNames: (call, options, tag) =>
    names(
      localeOf(call, tag),
      options,
      'month',
      Array.from({ length: 12 }, (_, m) => new Date(Date.UTC(2021, m, 15))),
    ),
  // 2021-01-04 was a Monday.
  dayNames: (call, options, tag) =>
    names(
      localeOf(call, tag),
      options,
      'weekday',
      Array.from({ length: 7 }, (_, d) => new Date(Date.UTC(2021, 0, 4 + d))),
    ),
};
