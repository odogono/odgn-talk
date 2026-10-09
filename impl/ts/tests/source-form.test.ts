import { describe, expect, test } from 'bun:test';
import { isReadable, sourceForm } from '../src/debug-api';
import {
  list,
  map,
  parseEntry,
  parseInstant,
  text,
  type Value,
} from '../src/index';
import { SessionHost } from '../src/session';
import { objectValue } from '../src/values';

const start = parseInstant('2026-09-30T10:00:00Z');

const session = () => {
  const host = new SessionHost({ now: () => start });
  const value = (name: string): Value =>
    host
      .inspect()!
      .scripts.find(s => s.name === 'session')!
      .vars.find(([n]) => n === name)![1];
  return { host, value };
};

// Each Entry builds a readable value whose source form reads back as an equal
// value with the same display form.
const readable: [string, string][] = [
  ['nothing', 'nothing'],
  ['true', 'true'],
  ['-2.50', '-2.50'],
  ['0.00', '0.00'],
  ['1 / 3', '0.3333333333333333333333333333333333'],
  ['-1 day', '-1 day'],
  ['0.5 1/s', '0.5 1/s'],
  ['6 m*s', '6 m*s'],
  ['"plain"', '"plain"'],
  ['""', '""'],
  ['"say " & quote & "hi" & quote', '`say "hi"`'],
  ['"a" & newline & "b" & tab & "c"', '`a\\nb\\tc`'],
  ['fromCodePoint(13) & newline', '`\\u{D}\\n`'],
  ['"a" & fromCodePoint(65279) & "b"', '`a\\u{FEFF}b`'],
  ['"x" & fromCodePoint(8238) & "y"', '`x\\u{202E}y`'],
  ['quote & fromCodePoint(769)', '`"́`'],
  ['quote & "`\\${"', '`"\\`\\\\\\${`'],
  ['quote & "$ {} $"', '`"$ {} $`'],
  ['<<>>', '<<>>'],
  ['<<0x0D, 0x0A>>', '<<0x0D, 0x0A>>'],
  ['[1..3]', '[1..3]'],
  ['-2..-1', '-2..-1'],
  ['3 m/s..7 m/s', '3 m/s..7 m/s'],
  ['{if: true, sku: "A1"}', '{if: true, sku: "A1"}'],
  ['{"offer": 1}', '{"offer": 1}'],
  ['{"unit price": 2}', '{"unit price": 2}'],
  ['{`"x`: 1}', '{`"x`: 1}'],
  ['{`a\\nb`: 1}', '{`a\\nb`: 1}'],
  ['{"`": 1, "${": 2}', '{"`": 1, "${": 2}'],
  ['{`"\\``: 1, `"\\${`: 2}', '{`"\\``: 1, `"\\${`: 2}'],
  ['{`\\u{202E}`: 1}', '{`\\u{202E}`: 1}'],
  ['{a: nothing}', '{a: nothing}'],
  ['{}', '{}'],
  ['"2026-09-27" as civil date', '("2026-09-27" as civil date)'],
  [
    '"2026-09-27T14:30:00.5" as civil date',
    '("2026-09-27T14:30:00.5" as civil date)',
  ],
  [
    '"2026-09-28T10:00:00.25+01:00" as instant',
    '("2026-09-28T09:00:00.25Z" as instant)',
  ],
  ['<"ID-", 4 digits>', '<"ID-", 4 digits>'],
  ['< <4 digits>, "x">', '< <4 digits>, "x">'],
  ['<(quote & "x"), 2 digits>', '<(quote & "x"), 2 digits>'],
];

describe('the source form', () => {
  test.each(readable)('%s reads back equal', (entry, expected) => {
    const { host, value } = session();
    expect(host.input(`put ${entry} into v`)).toEqual([]);
    const v = value('v');
    const source = sourceForm(v);
    expect(source).toBe(expected);
    expect(isReadable(v)).toBe(true);
    expect(host.input(`put ${source} into w`)).toEqual([]);
    expect(host.input('v = w')).toEqual(['true']);
    expect(value('w').toString()).toBe(v.toString());
  });

  test.each(readable)('%s reads back nested', entry => {
    const { host, value } = session();
    expect(host.input(`put ${entry} into v`)).toEqual([]);
    const item = sourceForm(value('v'));
    const nested: [string, string][] = [
      ['[v]', `[${item}]`],
      ['{k: v}', `{k: ${item}}`],
    ];
    for (const [i, [build, source]] of nested.entries()) {
      expect(host.input(`put ${build} into n${i}`)).toEqual([]);
      expect(sourceForm(value(`n${i}`))).toBe(source);
      expect(host.input(`constant c${i} = ${source}`)).toEqual([]);
      expect(host.input(`(c${i}) = n${i}`)).toEqual(['true']);
      expect(host.input(`c${i}`)).toEqual(host.input(`n${i}`));
    }
  });

  test('a range of dates and a map key that is a Reserved Word', () => {
    const { host, value } = session();
    host.input('put {} into m');
    host.input('put 1 into the offer of m');
    host.input('put [("2026-09-27" as civil date)] into the if of m');
    const source = sourceForm(value('m'));
    expect(source).toBe('{"offer": 1, if: [("2026-09-27" as civil date)]}');
    expect(host.input(`(${source}) = m`)).toEqual(['true']);
  });

  test('an unreadable value keeps its display form, which fails to parse', () => {
    const { host, value } = session();
    for (const source of [
      'function tax n\n  return n\nend tax',
      'put tax into named',
      'put 3 into k',
      'put given n: n * k into lambda',
      'put [1, tax] into holder',
    ]) {
      expect(host.input(source)).toEqual([]);
    }
    const object = objectValue({
      handle: {},
      id: 'object-slot-1',
      kind: 'item',
    });
    const values = [
      value('named'),
      value('lambda'),
      object,
      value('holder'),
      map([['o', list(text('a'), object)]]),
    ];
    for (const v of values) {
      expect(isReadable(v)).toBe(false);
      expect(sourceForm(v)).toBe(v.toString());
      expect(parseEntry(sourceForm(v), () => false).error).not.toBeNull();
    }
  });
});
