import { describe, expect, test } from 'bun:test';
import { compileSource } from '../src/lowering';
import { deliver, loadScript } from '../src/machine';
import { builtin } from '../src/operations';
import { parseInstant } from '../src/index';
import { instant, list, quantity, num, record, text } from '../src/values';

// Zone Rules for 2026: UTC+0 in winter, UTC+1 from 29 March 01:00Z to
// 25 October 01:00Z (chapter 7, Zone Rules; ADR 0179).
const LONDON = `{zone: "Europe/London", until: "2027-01-01T00:00:00Z" as instant,
    changes: [{at: "2026-01-01T00:00:00Z" as instant, offset: 0 s},
      {at: "2026-03-29T01:00:00Z" as instant, offset: 1 hr},
      {at: "2026-10-25T01:00:00Z" as instant, offset: 0 s}]}`;

// A `go` Handler's result, or its error's fields without `message` and `at`.
const value = (expr: string, setup = ''): string => {
  const compiled = compileSource(
    `on go\n  put ${LONDON} into z\n${setup}  return ${expr}\nend go`,
    { name: 't' },
  );
  if (!compiled.unit) {
    return `load ${compiled.diagnostics.map(d => d.code).join(', ')}`;
  }
  const outcome = deliver(loadScript(compiled.unit, {}), 'go', [], {}).finish();
  if (outcome.kind === 'completed') {
    return outcome.result.toString();
  }
  if (outcome.kind === 'errored') {
    const entries = outcome.error
      .entries()
      .filter(([k]) => k !== 'message' && k !== 'at' && k !== 'value');
    return `error ${entries.map(([k, v]) => `${k}: ${v}`).join(', ')}`;
  }
  return outcome.kind;
};
const c = (s: string) => `("${s}" as civil date)`;
const i = (s: string) => `("${s}" as instant)`;

describe('toCivil with Zone Rules', () => {
  test('reads the offset in effect at the Instant', () => {
    expect(value(`toCivil(${i('2026-02-01T12:00:00Z')}, z)`)).toBe(
      '2026-02-01T12:00:00',
    );
    expect(value(`toCivil(${i('2026-07-01T21:30:00Z')}, z)`)).toBe(
      '2026-07-01T22:30:00',
    );
    expect(value(`toCivil(${i('2026-10-25T01:00:00Z')}, z)`)).toBe(
      '2026-10-25T01:00:00',
    );
  });
  test('raises out of range outside the window', () => {
    expect(value(`toCivil(${i('2027-01-01T00:00:00Z')}, z)`)).toBe(
      'error code: "out of range", field: "zone"',
    );
    expect(value(`toCivil(${i('2025-12-31T23:59:59Z')}, z)`)).toBe(
      'error code: "out of range", field: "zone"',
    );
  });
  test('checks the whole map', () => {
    const bad = 'error code: "out of domain", function: "toCivil"';
    const at = `toCivil(${i('2026-02-01T12:00:00Z')}, z)`;
    expect(value(at, '  put [] into the changes of z\n')).toBe(bad);
    expect(value(at, '  put "yes" into the dst of z\n')).toBe(bad);
    expect(
      value(at, '  put 30 s into the offset of item 3 of the changes of z\n'),
    ).toBe(bad);
    expect(
      value(
        at,
        '  put [item 2 of the changes of z, item 1 of the changes of z] into the changes of z\n',
      ),
    ).toBe(bad);
    expect(
      value(at, `  put ${i('2026-10-25T01:00:00Z')} into the until of z\n`),
    ).toBe(bad);
    expect(value(at, '  put 5 into the zone of z\n')).toBe(bad);
    expect(value(`toCivil(${i('2026-02-01T12:00:00Z')}, {})`)).toBe(bad);
  });
});

describe('toInstant with Zone Rules', () => {
  const gap = c('2026-03-29T01:30:00');
  const overlap = c('2026-10-25T01:30:00');
  test('round-trips outside gaps and overlaps', () => {
    expect(value(`toInstant(${c('2026-07-01T22:30:00')}, z)`)).toBe(
      '2026-07-01T21:30:00Z',
    );
  });
  test('resolves a gap as calendar does', () => {
    expect(value(`toInstant(${gap}, z)`)).toBe('2026-03-29T01:30:00Z');
    expect(value(`toInstant(${gap}, z, "compatible")`)).toBe(
      '2026-03-29T01:30:00Z',
    );
    expect(value(`toInstant(${gap}, z, "earlier")`)).toBe(
      '2026-03-29T00:30:00Z',
    );
    expect(value(`toInstant(${gap}, z, "later")`)).toBe('2026-03-29T01:30:00Z');
  });
  test('resolves an overlap as calendar does', () => {
    expect(value(`toInstant(${overlap}, z)`)).toBe('2026-10-25T00:30:00Z');
    expect(value(`toInstant(${overlap}, z, "earlier")`)).toBe(
      '2026-10-25T00:30:00Z',
    );
    expect(value(`toInstant(${overlap}, z, "later")`)).toBe(
      '2026-10-25T01:30:00Z',
    );
  });
  test('"reject" raises ambiguous time with the map\'s zone', () => {
    expect(value(`toInstant(${gap}, z, "reject")`)).toBe(
      'error code: "ambiguous time", civil: 2026-03-29T01:30:00, zone: "Europe/London"',
    );
    expect(value(`toInstant(${overlap}, z, "reject")`)).toBe(
      'error code: "ambiguous time", civil: 2026-10-25T01:30:00, zone: "Europe/London"',
    );
  });
  test('refuses a Civil Date any offset would read outside the window', () => {
    expect(value(`toInstant(${c('2026-01-01T00:30:00')}, z)`)).toBe(
      'error code: "out of range", field: "zone"',
    );
    expect(value(`toInstant(${c('2026-12-31T23:30:00')}, z)`)).toBe(
      '2026-12-31T23:30:00Z',
    );
  });
  test('checks the disambiguation', () => {
    expect(value(`toInstant(${gap}, z, "nearest")`)).toBe(
      'error code: "out of domain", function: "toInstant"',
    );
    expect(value(`toInstant(${gap}, 1 hr, "later")`)).toBe(
      'error code: "out of domain", function: "toInstant"',
    );
    expect(value(`toInstant(${gap}, 1 hr, nothing)`)).toBe(
      '2026-03-29T00:30:00Z',
    );
  });
});

describe('Zone Rules in a Guard', () => {
  test('a Guard may convert with Zone Rules', () => {
    const compiled = compileSource(
      `on night t, z where hour(toCivil(t, z)) >= 22\n  return "night"\nend night\non night t, z\n  return "day"\nend night`,
      { name: 't' },
    );
    expect(compiled.diagnostics).toEqual([]);
  });
});

const rules = (n: number) =>
  record({
    zone: text('X'),
    until: instant(parseInstant('2027-01-01T00:00:00Z')!),
    changes: list(
      ...Array.from({ length: n }, (_, k) =>
        record({
          at: instant(parseInstant('2026-01-01T00:00:00Z')! + BigInt(k)),
          offset: quantity(num(0), 's'),
        }),
      ),
    ),
  });

describe('Fuel per change', () => {
  test('scanned counts the changes, and a fixed offset scans none', () => {
    const at = instant(parseInstant('2026-06-01T00:00:00Z')!);
    expect(builtin('toCivil', [at, rules(3)]).scanned).toBe(3);
    expect(builtin('toCivil', [at, rules(10)]).scanned).toBe(10);
    expect(builtin('toCivil', [at, quantity(num(0), 's')]).scanned).toBe(
      undefined,
    );
  });
  test('a malformed map is still charged for its changes', () => {
    const measure: { scanned?: number } = {};
    const bad = record({
      zone: text('X'),
      until: instant(0n),
      changes: list(text('a'), text('b')),
    });
    expect(() =>
      builtin(
        'toCivil',
        [instant(parseInstant('2026-06-01T00:00:00Z')!), bad],
        measure,
      ),
    ).toThrow();
    expect(measure.scanned).toBe(2);
  });
});
