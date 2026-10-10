import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyFile } from '../../../tools/unicode/generate';
import unicode from '../../../spec/data/unicode.toml';
import {
  assertScalarText,
  normalizeNFC,
  characterBoundaries,
  simpleFold,
  upper,
  lower,
  generalCategory,
  isWhiteSpace,
  scalarCount,
} from '../src/unicode';

const dataRoot = resolve(import.meta.dir, '../../../.cache/unicode/18.0.0');
const rows = (name: string) =>
  readFileSync(resolve(dataRoot, name), 'utf8').split(/\r?\n/);
const hexText = (s: string) =>
  s
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(n => String.fromCodePoint(Number.parseInt(n, 16)))
    .join('');

beforeAll(() => {
  for (const file of unicode.file) {
    verifyFile(file.path, readFileSync(resolve(dataRoot, file.path)));
  }
});

test('Unicode source bytes must match the spec pin', () => {
  expect(() =>
    verifyFile('CaseFolding.txt', new Uint8Array([1, 2, 3])),
  ).toThrow('SHA-256');
});

describe('Unicode scalar text', () => {
  test('rejects lone surrogates without replacing them', () => {
    for (const s of ['\ud800', 'a\udfff', '\ud800\ud800', '\udfff\ud800']) {
      expect(() => assertScalarText(s)).toThrow();
      expect(() => normalizeNFC(s)).toThrow();
    }
    expect(() => assertScalarText('\u0000\uFFFF\u{10FFFF}😀')).not.toThrow();
  });
  test('counts scalars as the string iterator does', () => {
    for (const s of [
      '',
      'abc',
      'é😀a\u{10FFFF}',
      '\ud800',
      '\ud800\ud800\udc00',
      '\udc00\ud800',
    ]) {
      expect(scalarCount(s), JSON.stringify(s)).toBe(Array.from(s).length);
    }
  });
});

test('NFC passes all five columns of the pinned NormalizationTest', () => {
  let count = 0;
  for (const [i, raw] of rows('NormalizationTest.txt').entries()) {
    const line = raw.split('#')[0]!.trim();
    if (!line || line.startsWith('@')) {
      continue;
    }
    const [c1, c2, c3, c4, c5] = line.split(';').slice(0, 5).map(hexText);
    for (const input of [c1!, c2!, c3!]) {
      expect(normalizeNFC(input), `NFC line ${i + 1}`).toBe(c2!);
    }
    for (const input of [c4!, c5!]) {
      expect(normalizeNFC(input), `NFC line ${i + 1}`).toBe(c4!);
    }
    count++;
  }
  expect(count).toBeGreaterThan(19_000);
});

test("NFC leaves every scalar absent from NormalizationTest's first column unchanged", () => {
  const listed = new Set<number>();
  for (const raw of rows('NormalizationTest.txt')) {
    const first = raw.split('#')[0]!.split(';')[0]!.trim();
    if (/^[\dA-F]+$/.test(first)) {
      listed.add(Number.parseInt(first, 16));
    }
  }
  for (let cp = 0; cp <= 0x10_ff_ff; cp++) {
    if ((cp >= 0xd8_00 && cp <= 0xdf_ff) || listed.has(cp)) {
      continue;
    }
    const s = String.fromCodePoint(cp);
    if (normalizeNFC(s) !== s) {
      throw new Error(`Unlisted scalar U+${cp.toString(16)} changed under NFC`);
    }
  }
});

test('Character boundaries pass every pinned GraphemeBreakTest row', () => {
  let count = 0;
  for (const [i, raw] of rows('auxiliary/GraphemeBreakTest.txt').entries()) {
    const line = raw.split('#')[0]!.trim();
    if (!line) {
      continue;
    }
    let input = '';
    const boundaries: number[] = [];
    for (const token of line.split(/\s+/)) {
      if (token === '÷') {
        boundaries.push(input.length);
      } else if (token !== '×') {
        input += hexText(token);
      }
    }
    expect(characterBoundaries(input), `grapheme line ${i + 1}`).toEqual(
      boundaries,
    );
    count++;
  }
  expect(count).toBeGreaterThan(500);
});

test('simple folding uses every C/S mapping and excludes full/Turkic mappings', () => {
  let count = 0;
  for (const [i, raw] of rows('CaseFolding.txt').entries()) {
    const line = raw.split('#')[0]!.trim();
    if (!line) {
      continue;
    }
    const [source, status, mapped] = line.split(';').map(s => s.trim());
    if (status !== 'C' && status !== 'S') {
      continue;
    }
    expect(simpleFold(hexText(source!)), `fold line ${i + 1}`).toBe(
      hexText(mapped!),
    );
    count++;
  }
  expect(count).toBeGreaterThan(1500);
  expect(simpleFold('ßİIςΣẞ')).toBe('ßİiσσß');
});

test('full case mapping uses UnicodeData and all unconditional SpecialCasing entries', () => {
  const full = new Map<number, [string, string]>();
  for (const raw of rows('SpecialCasing.txt')) {
    const line = raw.split('#')[0]!.trim();
    if (!line) {
      continue;
    }
    const [cp, lo, , up, condition] = line.split(';').map(s => s.trim());
    if (!condition) {
      full.set(Number.parseInt(cp!, 16), [hexText(lo!), hexText(up!)]);
    }
  }
  for (const raw of rows('UnicodeData.txt')) {
    const fields = raw.split(';');
    if (fields.length < 15) {
      continue;
    }
    const cp = Number.parseInt(fields[0]!, 16);
    // UnicodeData includes surrogate ranges, which are not Unicode scalar values.
    if (cp >= 0xd8_00 && cp <= 0xdf_ff) {
      continue;
    }
    const input = String.fromCodePoint(cp);
    const mapping = full.get(cp);
    const lo = mapping?.[0] ?? (fields[13] ? hexText(fields[13]) : input);
    const up = mapping?.[1] ?? (fields[12] ? hexText(fields[12]) : input);
    expect(lower(input), `lower U+${fields[0]}`).toBe(normalizeNFC(lo));
    expect(upper(input), `upper U+${fields[0]}`).toBe(normalizeNFC(up));
  }
  expect(upper('Straße ﬃ')).toBe('STRASSE FFI');
  expect(lower("İ ΟΣ ΟΣΑ ΟΣ' ΟΣ'Α Σ 1Σ A\u0301Σ\u0301")).toBe(
    "i\u0307 ος οσα ος' οσ'α σ 1σ áς\u0301",
  );
});

test('empty text, normalization seams, Hangul and scalar properties', () => {
  expect(characterBoundaries('')).toEqual([0]);
  expect(normalizeNFC('e\u0301')).toBe('é');
  expect(normalizeNFC('\u1100\u1161\u11a8')).toBe('각');
  expect(normalizeNFC('\u212B')).toBe('Å');
  expect(generalCategory(0x41)).toBe('Lu');
  expect(generalCategory(0x4e_01)).toBe('Lo');
  expect(generalCategory(0x3_78)).toBe('Cn');
  expect(isWhiteSpace(0x20_03)).toBe(true);
  expect(isWhiteSpace(0x20_0b)).toBe(false);
});
