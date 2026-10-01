import { expect, test } from 'bun:test';
import {
  characters,
  compareText,
  findText,
  joinText,
  textChunks,
} from '../src/text';

test('Characters retain whole emoji, combining and CRLF sequences', () => {
  expect(characters('a\u0301👨‍👩‍👧\r\n🇬🇧')).toEqual([
    'a\u0301',
    '👨‍👩‍👧',
    '\r\n',
    '🇬🇧',
  ]);
  expect(characters('')).toEqual([]);
});

test('plain-text search matches only whole Character boundaries', () => {
  expect(findText('👧', 'x👨‍👩‍👧👧')).toEqual({ from: 3, to: 3 });
  expect(findText('a', 'a\u0301')).toBeUndefined();
  expect(findText('\u0301', 'a\u0301')).toBeUndefined();
  expect(findText('\n', '\r\n')).toBeUndefined();
  expect(findText('cat', 'catcat', 2)).toEqual({ from: 4, to: 6 });
  expect(findText('é', '😀é')).toEqual({ from: 2, to: 2 });
  expect(findText('CAT', 'cat', 1, true)).toEqual({ from: 1, to: 3 });
  expect(findText('ss', 'ß', 1, true)).toBeUndefined();
  expect(findText('', 'abc')).toEqual({ from: 1, to: 0 });
  expect(findText('', '', 1)).toEqual({ from: 1, to: 0 });
});

test('text order compares scalar values rather than UTF-16 units', () => {
  expect(compareText('\uE000', '😀')).toBe(-1);
  expect(compareText('a', 'ab')).toBe(-1);
  expect(compareText('É', 'é', true)).toBe(0);
  expect(compareText('Z', 'a')).toBe(-1);
  expect(compareText('Z', 'a', true)).toBe(1);
});

test('joins normalize across seams', () => {
  expect(joinText('e', '\u0301')).toBe('é');
  expect(joinText('\u1100', '\u1161', '\u11a8')).toBe('각');
});

test("word chunks use the first scalar's White_Space and retain punctuation", () => {
  expect(textChunks('  cat,\u2003dog! \u0301a b', 'word')).toEqual([
    'cat,',
    'dog!',
    'a',
    'b',
  ]);
  expect(textChunks('cat, dog', 'word')).toEqual(['cat,', 'dog']);
  expect(textChunks('\u200Bfoo', 'word')).toEqual(['\u200Bfoo']);
});

test('line and item chunks retain interior empty chunks and drop a trailing empty chunk', () => {
  expect(textChunks('a\r\nb\rc\n', 'line')).toEqual(['a', 'b', 'c']);
  expect(textChunks('a,, b,', 'item')).toEqual(['a', '', ' b']);
  expect(textChunks(',', 'item')).toEqual(['']);
  expect(textChunks('a<>b<>', 'item', '<>')).toEqual(['a', 'b']);
  expect(textChunks('👨‍👩‍👧,👧', 'item', '👧')).toEqual(['👨‍👩‍👧,']);
  for (const kind of [
    'item',
    'line',
    'word',
    'character',
    'code point',
  ] as const) {
    expect(textChunks('', kind)).toEqual([]);
  }
  expect(textChunks('é😀', 'code point')).toEqual(['é', '😀']);
  expect(() => textChunks('abc', 'item', '')).toThrow();
});
