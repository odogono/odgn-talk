#!/usr/bin/env bun
// Build-time only. Runtime code imports the generated TS, never TOML or UCD files.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import unicode from '../../spec/data/unicode.toml';
import { generateGoUnicode } from './generate-go';
import { generateZigUnicode } from './generate-zig';
import { writeOutput } from '../go/output';

const root = resolve(import.meta.dir, '../..');
export const cacheDir = resolve(root, '.cache/unicode', unicode.version);
type Pin = { path: string; sha256: string };
const pins = unicode.file as Pin[];

export const verifyFile = (path: string, bytes: Uint8Array): void => {
  const pin = pins.find(file => file.path === path);
  if (!pin) {
    throw new Error(`Unpinned Unicode file: ${path}`);
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== pin.sha256) {
    throw new Error(`${path}: SHA-256 ${actual}, expected ${pin.sha256}`);
  }
};

export const readPinnedFile = async (path: string): Promise<string> => {
  const local = resolve(cacheDir, path);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(local);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    const response = await fetch(
      `https://www.unicode.org/Public/${unicode.version}/ucd/${path}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!response.ok) {
      throw new Error(`${path}: HTTP ${response.status}`);
    }
    bytes = new Uint8Array(await response.arrayBuffer());
    // Never cache unverified responses. Existing corrupt cache files fail, too.
    verifyFile(path, bytes);
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, bytes);
  }
  verifyFile(path, bytes);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
};

type Range = [number, number, string | number];
type Mapping = Record<number, number[]>;
const hex = (s: string) => Number.parseInt(s, 16);
const points = (s: string) => s.trim().split(/\s+/).filter(Boolean).map(hex);
const rows = (s: string) =>
  s
    .split(/\r?\n/)
    .map(l => l.split('#')[0]!.trim())
    .filter(Boolean)
    .map(l => l.split(';').map(f => f.trim()));

const compact = (ranges: Range[]): Range[] => {
  ranges.sort((a, b) => a[0] - b[0]);
  const result: Range[] = [];
  for (const range of ranges) {
    const prev = result.at(-1);
    if (prev && range[0] <= prev[1]) {
      throw new Error('Overlapping Unicode ranges');
    }
    if (prev && prev[1] + 1 === range[0] && prev[2] === range[2]) {
      prev[1] = range[1];
    } else {
      result.push([...range]);
    }
  }
  return result;
};

const property = (
  text: string,
  select: (fields: string[]) => string | number | undefined,
): Range[] =>
  compact(
    rows(text).flatMap(fields => {
      const value = select(fields);
      if (value === undefined) {
        return [];
      }
      const [start, end] = fields[0]!.split('..').map(hex);
      return [[start!, end ?? start!, value] as Range];
    }),
  );

export const generateUnicodeData = (files: Map<string, string>) => {
  const file = (path: string) => {
    const content = files.get(path);
    if (content === undefined) {
      throw new Error(`Missing Unicode file: ${path}`);
    }
    return content;
  };
  const category: Range[] = [];
  const combining: Range[] = [];
  const decomposition: Mapping = {};
  const uppercase: Mapping = {};
  const lowercase: Mapping = {};
  let first: number | undefined;
  for (const fields of rows(file('UnicodeData.txt'))) {
    const cp = hex(fields[0]!);
    if (fields[1]!.endsWith(', First>')) {
      first = cp;
      continue;
    }
    const start = fields[1]!.endsWith(', Last>') ? first! : cp;
    if (!Number.isInteger(start)) {
      throw new Error('Unpaired UnicodeData range');
    }
    category.push([start, cp, fields[2]!]);
    if (fields[3] !== '0') {
      combining.push([start, cp, Number(fields[3])]);
    }
    if (fields[5] && !fields[5].startsWith('<')) {
      decomposition[cp] = points(fields[5]);
    }
    if (fields[12]) {
      uppercase[cp] = points(fields[12]);
    }
    if (fields[13]) {
      lowercase[cp] = points(fields[13]);
    }
    first = undefined;
  }
  const excluded = new Set(
    rows(file('CompositionExclusions.txt')).map(f => hex(f[0]!)),
  );
  const ccc = new Map<number, number>();
  for (const [start, end, value] of combining) {
    for (let cp = start; cp <= end; cp++) {
      ccc.set(cp, value as number);
    }
  }
  const composition: Record<number, number> = {};
  for (const [key, parts] of Object.entries(decomposition)) {
    // Full_Composition_Exclusion also excludes singletons and non-starter decompositions.
    if (
      parts.length === 2 &&
      !excluded.has(Number(key)) &&
      !ccc.has(parts[0]!)
    ) {
      composition[parts[0]! * 0x11_00_00 + parts[1]!] = Number(key);
    }
  }
  const folding: Record<number, number> = {};
  for (const [cp, status, mapped] of rows(file('CaseFolding.txt'))) {
    if (status === 'C' || status === 'S') {
      folding[hex(cp!)] = hex(mapped!);
    }
  }
  const finalSigma: Mapping = {};
  for (const [cp, lo, , up, condition] of rows(file('SpecialCasing.txt'))) {
    if (!condition) {
      lowercase[hex(cp!)] = points(lo!);
      uppercase[hex(cp!)] = points(up!);
    } else if (condition === 'Final_Sigma') {
      finalSigma[hex(cp!)] = points(lo!);
    } else if (!/^(lt|tr|az)( |$)/.test(condition)) {
      throw new Error(`Unhandled default case condition: ${condition}`);
    }
  }
  const derived = file('DerivedCoreProperties.txt');
  return {
    unicodeVersion: unicode.version,
    sourceHashes: Object.fromEntries(pins.map(p => [p.path, p.sha256])),
    category: compact(category),
    combining: compact(combining),
    decomposition,
    composition,
    folding,
    uppercase,
    lowercase,
    finalSigma,
    grapheme: property(file('auxiliary/GraphemeBreakProperty.txt'), f => f[1]),
    indic: property(derived, f => (f[1] === 'InCB' ? f[2] : undefined)),
    pictographic: property(file('emoji/emoji-data.txt'), f =>
      f[1] === 'Extended_Pictographic' ? 1 : undefined,
    ),
    whitespace: property(file('PropList.txt'), f =>
      f[1] === 'White_Space' ? 1 : undefined,
    ),
    cased: property(derived, f => (f[1] === 'Cased' ? 1 : undefined)),
    caseIgnorable: property(derived, f =>
      f[1] === 'Case_Ignorable' ? 1 : undefined,
    ),
  };
};

export const generateTables = (files: Map<string, string>): string =>
  emitTables(generateUnicodeData(files));

// Packed tables are strings of unsigned varints, decoded by impl/ts/src/unicode.ts.
// Each digit holds five bits, least significant first; 32 marks a following digit.
const DIGITS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const varint = (n: number): string => {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Unpackable Unicode value: ${n}`);
  }
  let result = '';
  while (n >= 32) {
    result += DIGITS[32 + (n % 32)];
    n = Math.floor(n / 32);
  }
  return result + DIGITS[n];
};
const zigzag = (n: number) => (n < 0 ? -2 * n - 1 : 2 * n);

// Fields are packed column by column, which compresses better than row by row.
// A range table is its count, then each range's gap from the previous range,
// then each length and, unless every range has the same value, each value's
// index. A property whose only value is 1 is emitted as just the packed string.
const packRanges = (ranges: Range[]) => {
  const values = [...new Set(ranges.map(range => range[2]))];
  const gaps = ranges.map(
    ([start], i) => start - (ranges[i - 1]?.[1] ?? -1) - 1,
  );
  const lengths = ranges.map(([start, end]) => end - start);
  const indexes =
    values.length > 1 ? ranges.map(range => values.indexOf(range[2])) : [];
  return {
    packed: [ranges.length, ...gaps, ...lengths, ...indexes]
      .map(varint)
      .join(''),
    values,
  };
};

// A mapping is its count and whether each first value is a delta from its key
// (0) or from the previous first value (1). Then come each key's gap from the
// previous key, each list's length (for lists), each first value, and the
// remaining values, each as a signed delta from the remaining value before.
const packMapping = (
  mapping: Record<number, number | number[]>,
  fromPrevious = false,
) => {
  const entries = Object.entries(mapping).map(
    ([key, value]) =>
      [Number(key), typeof value === 'number' ? [value] : value] as const,
  );
  const lists = Object.values(mapping).some(value => Array.isArray(value));
  const gaps: number[] = [],
    lengths: number[] = [],
    firsts: number[] = [],
    rest: number[] = [];
  let previousKey = -1,
    previousFirst = 0,
    previousRest = 0;
  for (const [key, [first, ...others]] of entries) {
    if (first === undefined) {
      throw new Error('Empty Unicode mapping');
    }
    gaps.push(key - previousKey - 1);
    lengths.push(others.length + 1);
    firsts.push(zigzag(first - (fromPrevious ? previousFirst : key)));
    for (const cp of others) {
      rest.push(zigzag(cp - previousRest));
      previousRest = cp;
    }
    previousKey = key;
    previousFirst = first;
  }
  return [
    entries.length,
    fromPrevious ? 1 : 0,
    ...gaps,
    ...(lists ? lengths : []),
    ...firsts,
    ...rest,
  ]
    .map(varint)
    .join('');
};

const emitTables = (output: ReturnType<typeof generateUnicodeData>): string => {
  const {
    unicodeVersion,
    sourceHashes,
    composition,
    decomposition,
    ...tables
  } = output;
  // Composition is rebuilt from the pairs in decomposition that do not compose.
  const composed = new Set(Object.values(composition));
  const exclusions = Object.keys(decomposition)
    .map(Number)
    .filter(cp => decomposition[cp]!.length === 2 && !composed.has(cp));
  if (
    Object.keys(decomposition).filter(
      cp => decomposition[Number(cp)]!.length === 2,
    ).length !==
    exclusions.length + composed.size
  ) {
    throw new Error('Composition is not derivable from decomposition');
  }
  let result =
    '// Generated by tools/unicode/generate.ts from spec/data/unicode.toml. Do not edit.\n// Unicode data © Unicode, Inc.; https://www.unicode.org/license.txt\n';
  result += `export const unicodeVersion: string = ${JSON.stringify(unicodeVersion)};\n`;
  result += `export const sourceHashes: Readonly<Record<string, string>> = {\n${Object.entries(
    sourceHashes,
  )
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
    .join('\n')}\n};\n`;
  result += `export const decomposition: string =\n  ${JSON.stringify(packMapping(decomposition, true))};\n`;
  const packedExclusions = exclusions
    .map((cp, i) => varint(cp - (exclusions[i - 1] ?? -1) - 1))
    .join('');
  result += `export const compositionExclusions: string =\n  ${JSON.stringify(packedExclusions)};\n`;
  for (const [name, value] of Object.entries(tables)) {
    if (Array.isArray(value)) {
      const { packed, values } = packRanges(value);
      if (values.length === 1 && values[0] === 1) {
        result += `export const ${name}: string =\n  ${JSON.stringify(packed)};\n`;
        continue;
      }
      const type = typeof values[0] === 'string' ? 'string' : 'number';
      result += `export const ${name}: readonly [string, readonly ${type}[]] = [\n  ${JSON.stringify(packed)},\n  ${JSON.stringify(values)},\n];\n`;
    } else {
      result += `export const ${name}: string =\n  ${JSON.stringify(packMapping(value))};\n`;
    }
  }
  return result;
};

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.some(arg => arg !== '--check')) {
    throw new Error('Usage: bun tools/unicode/generate.ts [--check]');
  }
  const files = new Map(
    await Promise.all(
      pins.map(
        async pin => [pin.path, await readPinnedFile(pin.path)] as const,
      ),
    ),
  );
  const data = generateUnicodeData(files);
  const generated = emitTables(data);
  const target = resolve(root, 'impl/ts/src/generated/unicode.ts');
  if (args.includes('--check')) {
    let current = '';
    try {
      current = await readFile(target, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    if (current !== generated) {
      throw new Error('Unicode tables are stale; run bun run unicode:generate');
    }
  } else {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, generated);
  }
  await generateGoUnicode(data, args.includes('--check'));
  await generateZigUnicode(data, args.includes('--check'));
  const license = await readFile(
    resolve(import.meta.dir, 'UNICODE-LICENSE.txt'),
    'utf8',
  );
  for (const directory of [
    'impl/ts/src/generated',
    'impl/go/internal/generated',
    'impl/zig/src/generated',
  ]) {
    await writeOutput(
      resolve(root, directory, 'UNICODE-LICENSE.txt'),
      license,
      args.includes('--check'),
      'bun run unicode:generate',
    );
  }
  console.log(
    `Unicode ${unicode.version}: ${pins.length} verified files; tables ${args.includes('--check') ? 'match' : 'generated'}`,
  );
}
