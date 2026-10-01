#!/usr/bin/env bun
// Build-time only. Runtime code imports the generated TS, never TOML or UCD files.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import unicode from '../../spec/data/unicode.toml';

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

export const generateTables = (files: Map<string, string>): string => {
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
  const output: Record<string, unknown> = {
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
  let result =
    '// Generated by tools/unicode/generate.ts from spec/data/unicode.toml. Do not edit.\n// Unicode data © Unicode, Inc.; https://www.unicode.org/license.txt\n';
  for (const [name, value] of Object.entries(output)) {
    const type = Array.isArray(value)
      ? `readonly (readonly [number, number, ${typeof value[0]?.[2] === 'string' ? 'string' : 'number'}])[]`
      : typeof value === 'string'
        ? 'string'
        : name === 'sourceHashes'
          ? 'Readonly<Record<string, string>>'
          : ['composition', 'folding'].includes(name)
            ? 'Readonly<Record<number, number>>'
            : 'Readonly<Record<number, readonly number[]>>';
    const content = Array.isArray(value)
      ? `[\n${value.map(v => `  ${JSON.stringify(v)},`).join('\n')}\n]`
      : typeof value === 'object'
        ? `{\n${Object.entries(value as object)
            .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
            .join('\n')}\n}`
        : JSON.stringify(value);
    result += `export const ${name}: ${type} = ${content};\n`;
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
  const generated = generateTables(files);
  const target = resolve(root, 'src/generated/unicode.ts');
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
  console.log(
    `Unicode ${unicode.version}: ${pins.length} verified files; tables ${args.includes('--check') ? 'match' : 'generated'}`,
  );
}
