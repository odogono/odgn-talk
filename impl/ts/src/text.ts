// Text helpers for the future Abstract Machine. Inputs are scalar text; Core
// values already ensure NFC. These do no Fuel accounting outside a Run.
import { invalidValue } from './errors';
import {
  assertScalarText,
  characterBoundaries,
  isWhiteSpace,
  normalizeNFC,
  simpleFold,
} from './unicode';

export const characters = (s: string): string[] => {
  const boundaries = characterBoundaries(s);
  return boundaries
    .slice(0, -1)
    .map((from, i) => s.slice(from, boundaries[i + 1]));
};
export const joinText = (...pieces: string[]): string =>
  normalizeNFC(pieces.join(''));

export const compareText = (
  a: string,
  b: string,
  ignoringCase = false,
): -1 | 0 | 1 => {
  assertScalarText(a);
  assertScalarText(b);
  const left = Array.from(ignoringCase ? simpleFold(a) : a, ch =>
    ch.codePointAt(0)!,
  );
  const right = Array.from(ignoringCase ? simpleFold(b) : b, ch =>
    ch.codePointAt(0)!,
  );
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) {
      return left[i]! < right[i]! ? -1 : 1;
    }
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
};

// KMP on Characters keeps literal search linear, including repeated prefixes.
const matchStarts = function* (
  needle: string[],
  subject: string[],
  start = 0,
): Generator<number> {
  if (needle.length === 0) {
    for (let i = start; i <= subject.length; i++) {
      yield i;
    }
    return;
  }
  const prefix = new Array<number>(needle.length).fill(0);
  for (let i = 1, k = 0; i < needle.length; i++) {
    while (k > 0 && needle[i] !== needle[k]) {
      k = prefix[k - 1]!;
    }
    if (needle[i] === needle[k]) {
      k++;
    }
    prefix[i] = k;
  }
  for (let i = start, k = 0; i < subject.length; i++) {
    while (k > 0 && subject[i] !== needle[k]) {
      k = prefix[k - 1]!;
    }
    if (subject[i] === needle[k]) {
      k++;
    }
    if (k === needle.length) {
      yield i - k + 1;
      k = prefix[k - 1]!;
    }
  }
};

/** 1-based inclusive Character range; an empty match before p is p..p-1. */
export const findText = (
  needle: string,
  subject: string,
  start = 1,
  ignoringCase = false,
): { from: number; to: number } | undefined => {
  if (!Number.isInteger(start) || start < 1) {
    invalidValue('Search start must be a positive integer');
  }
  let pattern = characters(needle),
    chars = characters(subject);
  if (ignoringCase) {
    pattern = pattern.map(simpleFold);
    chars = chars.map(simpleFold);
  }
  const result = matchStarts(pattern, chars, start - 1).next();
  return result.done
    ? undefined
    : { from: result.value + 1, to: result.value + pattern.length };
};

export type TextChunk = 'character' | 'code point' | 'word' | 'line' | 'item';
export const textChunks = (
  s: string,
  kind: TextChunk,
  delimiter = ',',
): string[] => {
  const chars = characters(s);
  if (kind === 'character') {
    return chars;
  }
  if (kind === 'code point') {
    return Array.from(s);
  }
  if (kind === 'word') {
    const words: string[] = [];
    let run = '';
    for (const ch of chars) {
      if (isWhiteSpace(ch.codePointAt(0)!)) {
        if (run) {
          words.push(run);
        }
        run = '';
      } else {
        run += ch;
      }
    }
    if (run) {
      words.push(run);
    }
    return words;
  }
  const pattern = kind === 'item' ? characters(delimiter) : [];
  if (kind === 'item' && !pattern.length) {
    invalidValue('Delimiter must contain at least one Character');
  }
  if (!chars.length) {
    return [];
  }
  const chunks: string[] = [];
  let from = 0;
  if (kind === 'line') {
    for (let i = 0; i < chars.length; i++) {
      if (chars[i] === '\r' || chars[i] === '\n' || chars[i] === '\r\n') {
        chunks.push(chars.slice(from, i).join(''));
        from = i + 1;
      }
    }
  } else {
    for (const i of matchStarts(pattern, chars)) {
      if (i < from) {
        continue;
      } // Delimiters do not overlap.
      chunks.push(chars.slice(from, i).join(''));
      from = i + pattern.length;
    }
  }
  if (from < chars.length) {
    chunks.push(chars.slice(from).join(''));
  }
  return chunks;
};
