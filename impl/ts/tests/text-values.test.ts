import { expect, test } from 'bun:test';
import { appendTo, chunkGet, concat, property } from '../src/operations';
import { characters } from '../src/text';
import { normalizeNFC } from '../src/unicode';
import {
  concatText,
  num,
  range,
  sliceText,
  text,
  textStorage,
  type Value,
} from '../src/values';

const encoder = new TextEncoder();
const check = (value: Value, expected: string) => {
  expect(value.asText()).toBe(expected);
  const storage = textStorage(value);
  expect(storage.ascii).toBe(
    Array.from(expected).every(ch => ch.codePointAt(0)! < 128),
  );
  expect(storage.utf8Length).toBe(encoder.encode(expected).length);
  expect(storage.characterCount).toBe(characters(expected).length);
  expect(storage.characters).toEqual(characters(expected));
  expect(value.equals(text(expected))).toBe(true);
};

test('cached Text facts survive Unicode joins and retained originals in either association', () => {
  const pieces = [
    '',
    'a',
    'é',
    '\r',
    '\n',
    '\r\n',
    '\u0301',
    'q\u0301',
    '\u0327',
    '\u1100',
    '\u1161',
    '\u11a8',
    '가',
    '\u0600',
    '👨',
    '\u200d👩',
    '👩\u200d',
    '🇬',
    '🇧🇨🇦🇫',
    '🇬🇧🇨',
    'क्',
    'क',
    '\u093c',
    '\u09c7',
    '\u09be',
    '\u0f71',
  ].map(s => text(s));
  for (const left of pieces) {
    for (const right of pieces) {
      const joined = concatText(left, right);
      const expected = normalizeNFC(left.asText()! + right.asText()!);
      check(joined, expected);
      for (const third of pieces) {
        const full = normalizeNFC(expected + third.asText()!);
        check(concatText(joined, third), full);
        check(concatText(left, concatText(right, third)), full);
      }
      check(left, left.asText()!);
      check(right, right.asText()!);
    }
  }
});

test('all ASCII joins preserve Character counts, including CRLF and controls', () => {
  for (let a = 0; a < 128; a++) {
    for (let b = 0; b < 128; b++) {
      const joined = concat(
        text(String.fromCharCode(a)),
        text(String.fromCharCode(b)),
      );
      expect(textStorage(joined).characterCount).toBe(
        a === 13 && b === 10 ? 1 : 2,
      );
      expect(textStorage(joined).characters).toEqual(
        a === 13 && b === 10
          ? ['\r\n']
          : [String.fromCharCode(a), String.fromCharCode(b)],
      );
    }
  }
});

test('long Unicode builds retain exact facts without requesting Character arrays between joins', () => {
  const pieces = [
    'a',
    '\u0301',
    '\r',
    '\n',
    '🇬',
    '🇧🇨',
    '👩',
    '\u200d',
    '👨',
    '\u094d',
    '\u0308क',
    '\u0600',
    '\u1100',
    '\u1161',
    '\u11a8',
  ].map(text);
  let forward = text(''),
    backward = text('');
  let expectedForward = '',
    expectedBackward = '';
  for (let i = 0; i < 300; i++) {
    const piece = pieces[(i * 17 + Math.floor(i / 7)) % pieces.length]!;
    forward = concatText(forward, piece);
    backward = concatText(piece, backward);
    expectedForward = normalizeNFC(expectedForward + piece.asText()!);
    expectedBackward = normalizeNFC(piece.asText()! + expectedBackward);
    expect(forward.asText()).toBe(expectedForward);
    expect(backward.asText()).toBe(expectedBackward);
    expect(textStorage(forward).characterCount).toBe(
      characters(expectedForward).length,
    );
    expect(textStorage(backward).characterCount).toBe(
      characters(expectedBackward).length,
    );
    expect(textStorage(forward).utf8Length).toBe(
      encoder.encode(expectedForward).length,
    );
    expect(textStorage(backward).utf8Length).toBe(
      encoder.encode(expectedBackward).length,
    );
  }
});

test('Text Character views are cached and immutable; contiguous slices retain NFC', () => {
  const value = text('a\r\né👨‍👩‍👧q\u0301🇬🇧🇨🇦');
  const view = textStorage(value).characters;
  expect(textStorage(value).characters).toBe(view);
  expect(Object.isFrozen(view)).toBe(true);
  expect(Reflect.set(view, '0', 'changed')).toBe(false);
  for (let from = 0; from <= view.length; from++) {
    for (let to = from; to <= view.length; to++) {
      const expected = view.slice(from, to).join('');
      check(sliceText(value, from, to), expected);
      if (from < to) {
        check(
          chunkGet('character', range(num(from + 1), num(to)), value, null)
            .result,
          expected,
        );
      }
    }
  }
});

test('concatenation and put use text forms and normalize combining joins in both directions', () => {
  check(concat(text('item '), num(3)), 'item 3');
  check(appendTo(text('e'), text('\u0301'), 'append'), 'é');
  check(appendTo(text('\u0301'), text('e'), 'prepend'), 'é');
  expect(
    property('length', concat(text('🇬'), text('🇧🇨🇦')))
      .asDecimal()!
      .toBigInt(),
  ).toBe(2n);
});
