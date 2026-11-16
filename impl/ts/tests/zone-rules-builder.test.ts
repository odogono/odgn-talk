import { describe, expect, test } from 'bun:test';
import { HostError } from '../src/errors';
import { builtin } from '../src/operations';
import { instant, text, type Value } from '../src/values';
import { zoneRules } from '../src/zone-rules';

const changesOf = (rules: Value) => {
  const changes = rules.get('changes');
  return Array.from({ length: changes.length }, (_, k) => {
    const c = changes.index(k + 1);
    return `${c.get('at')} ${c.get('offset')}`;
  });
};

// The zone's offset at `ms` from a fresh Intl wall clock, in seconds.
const intlOffset = (zone: string, ms: number) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(new Date(ms))
      .map(p => [p.type, p.value]),
  );
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (wall - Math.floor(ms / 1000) * 1000) / 1000;
};

// The offset the rules give at `ms`, in seconds.
const rulesOffset = (rules: Value, ms: number) => {
  const changes = rules.get('changes');
  let offset = '';
  for (let k = 1; k <= changes.length; k++) {
    const c = changes.index(k);
    if (Number(c.get('at').asInstant()! / 1000n) <= ms) {
      offset = c.get('offset').toString();
    }
  }
  return offset;
};

const y2026 = new Date('2026-01-01T00:00:00Z');
const y2027 = new Date('2027-01-01T00:00:00Z');

describe('zoneRules', () => {
  test('finds each change in the window, to the second', () => {
    const rules = zoneRules('Europe/London', y2026, y2027);
    expect(rules.get('zone').toString()).toBe('"Europe/London"');
    expect(rules.get('until').toString()).toBe('2027-01-01T00:00:00Z');
    expect(changesOf(rules)).toEqual([
      '2026-01-01T00:00:00Z 0 s',
      '2026-03-29T01:00:00Z 3600 s',
      '2026-10-25T01:00:00Z 0 s',
    ]);
  });
  test('a zone with no changes has one', () => {
    expect(changesOf(zoneRules('Asia/Kolkata', y2026, y2027))).toEqual([
      '2026-01-01T00:00:00Z 19800 s',
    ]);
  });
  test('keeps the zone id as given', () => {
    expect(zoneRules('UTC', y2026, y2027).get('zone').toString()).toBe('"UTC"');
  });
  test('agrees with Intl across a southern-hemisphere and a half-hour zone', () => {
    for (const zone of [
      'Australia/Lord_Howe',
      'America/Santiago',
      'Europe/London',
    ]) {
      const from = new Date('2024-01-01T00:00:00Z');
      const until = new Date('2028-01-01T00:00:00Z');
      const rules = zoneRules(zone, from, until);
      for (
        let ms = from.getTime();
        ms < until.getTime();
        ms += 5 * 86_400_000 + 3_601_000
      ) {
        expect(`${zone} ${rulesOffset(rules, ms)}`).toBe(
          `${zone} ${intlOffset(zone, ms)} s`,
        );
      }
    }
  });
  test('refuses an unknown zone, an empty window and a window it can’t express', () => {
    expect(() => zoneRules('Mars/Olympus', y2026, y2027)).toThrow(HostError);
    expect(() => zoneRules('Europe/London', y2027, y2026)).toThrow(
      'an empty window',
    );
    // London kept local mean time, 75 s behind UTC, until 1847.
    expect(() =>
      zoneRules(
        'Europe/London',
        new Date('1840-01-01T00:00:00Z'),
        new Date('1841-01-01T00:00:00Z'),
      ),
    ).toThrow('not whole minutes');
  });
});

describe('zoneRules through toCivil and toInstant', () => {
  test('agree with Intl across the window', () => {
    for (const zone of ['Europe/London', 'Australia/Lord_Howe']) {
      const from = new Date('2025-01-01T00:00:00Z');
      const until = new Date('2028-01-01T00:00:00Z');
      const rules = zoneRules(zone, from, until);
      for (
        let ms = from.getTime() + 86_400_000;
        ms < until.getTime() - 86_400_000;
        ms += 3 * 86_400_000 + 3_601_000
      ) {
        const at = instant(BigInt(ms) * 1000n);
        const civil = builtin('toCivil', [at, rules]).result;
        const wall = new Date(ms + intlOffset(zone, ms) * 1000)
          .toISOString()
          .slice(0, 19);
        expect(`${zone} ${civil}`).toBe(`${zone} ${wall}`);
        // A wall clock outside a gap or overlap reads back as the Instant.
        const back = builtin('toInstant', [civil, rules, text('reject')]);
        expect(back.result.toString()).toBe(at.toString());
      }
    }
  });
});
