import { expect, test } from 'bun:test';
import { chunkGet } from '../src/operations';
import { characters } from '../src/text';
import { num, range, text } from '../src/values';

const resolve = (n: number, length: number) => (n < 0 ? length + 1 + n : n);
const checkCharacterRead = (source: string, from: number, to?: number) => {
  const whole = text(source);
  const cs = characters(whole.asText()!);
  const a = resolve(from, cs.length),
    b = resolve(to ?? from, cs.length);
  const selected = cs.flatMap((ch, i) =>
    i + 1 >= a && i + 1 <= b ? [{ ch, end: i + 1 }] : [],
  );
  const result = selected.map(x => x.ch).join('');
  const scanned = selected.at(-1)?.end ?? cs.length;
  const actual = chunkGet(
    'character',
    to === undefined ? num(from) : range(num(from), num(to)),
    whole,
    null,
  );
  expect(actual.result.asText()).toBe(text(result).asText());
  expect(actual.scanned).toBe(scanned);
};

// Resolve indexes independently of the implementation, including clipping only
// ranges. Every read also checks the cost-model walk length.
test('Character reads preserve results and scanned units across index combinations', () => {
  for (const source of [
    '',
    'abc',
    'q\u0301',
    'x'.repeat(64) + 'q\u0301',
    Array.from({ length: 128 }, (_, cp) => String.fromCodePoint(cp)).join(''),
    '\u0000\t\rX\n\u007f',
    'a\r\nb\rc\n',
    'éq\u0301👨‍👩‍👧🇬🇧',
    'a\u0301',
    '\u0600a',
    'क्षि',
    '각',
    '🇬🇧🇺🇸🇦',
  ]) {
    const whole = text(source);
    const cs = characters(whole.asText()!);
    const indexes = [-20, -5, -2, -1, 0, 1, 2, 3, 5, 20];
    for (const from of indexes) {
      checkCharacterRead(source, from);
      for (const to of indexes) {
        checkCharacterRead(source, from, to);
      }
    }
    const clipped = chunkGet(
      'character',
      range(num(-(10n ** 30n)), num(10n ** 30n)),
      whole,
      null,
    );
    expect(clipped.result.asText()).toBe(whole.asText());
    expect(clipped.scanned).toBe(cs.length);
    for (const from of [10n ** 30n, -(10n ** 30n)]) {
      const actual = chunkGet('character', num(from), whole, null);
      expect(actual.result.asText()).toBe('');
      expect(actual.scanned).toBe(cs.length);
    }
  }
});

test('other text reads retain separators, empty chunks and unit-based scanning', () => {
  for (const [kind, source, from, to, delimiter, result, scanned] of [
    ['word', '  é  👨‍👩‍👧 end ', 1, 2, null, 'é  👨‍👩‍👧', 6],
    ['line', 'é\r\n\r\nx\n', 1, 2, null, 'é\r\n', 2],
    ['item', 'é<>👨‍👩‍👧<><>x<>', 2, 3, '<>', '👨‍👩‍👧<>', 6],
    ['item', '👨‍👩‍👧,👧', 1, 1, '👧', '👨‍👩‍👧,', 2],
    ['item', ',,', 1, 1, null, '', 0],
    ['item', 'a,b,', 9, 9, null, '', 4],
    ['word', '   ', -1, -1, null, '', 3],
    ['line', '', 1, 1, null, '', 0],
    ['code point', 'q\u0301😀', 2, 3, null, '\u0301😀', 3],
    ['code point', '\r\n😀', -1, -1, null, '😀', 3],
  ] as const) {
    const actual = chunkGet(
      kind,
      range(num(from), num(to)),
      text(source),
      delimiter === null ? null : text(delimiter),
    );
    expect(actual.result.asText()).toBe(text(result).asText());
    expect(actual.scanned).toBe(scanned);
  }
});

test('chunk reads validate indexes and delimiters before taking fast paths', () => {
  for (const kind of ['character', 'code point', 'word', 'item', 'line']) {
    expect(() => chunkGet(kind, num(1.5), text('abc'), null)).toThrow();
    expect(() => chunkGet(kind, text('1'), text('abc'), null)).toThrow();
    expect(() => chunkGet(kind, num(1), text('abc'), text(''))).toThrow();
    expect(() => chunkGet(kind, num(1), text('abc'), num(1))).toThrow();
  }
});
