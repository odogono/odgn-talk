#!/usr/bin/env bun
// Execute implemented Corpus case kinds. This is distinct from corpus:check,
// which checks formats. Only `--bless` writes, and only the cases it names.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  checkSource,
  disassemble,
  encodeValue,
  exportsOf,
  lowerTree,
  readDisplay,
  type CodeUnit,
  type LibraryExport,
} from '../src/index';
import { DeferredCaseError, runTraceCase, unblessed } from './trace-case';
import { runTranscriptCase } from './transcript-case';

const root = resolve(import.meta.dir, '../../..');
const corpusRoot = resolve(root, 'corpus');
/** The case kinds this Core executes; every other kind is deferred. */
const supported = new Set(['encoding', 'disassembly', 'trace', 'transcript']);
type Setup = {
  disassembly?: { expected: string; unit: string }[];
  kind: string;
  libraries?: { name: string; source: string; version: string }[];
  objects?: { id: string; kind: string; props?: Record<string, string> }[];
  scripts?: {
    name: string;
    objects?: Record<string, { id: string; kind: string }>;
    source: string;
  }[];
  versions: { costModel: string; language: string };
};
const readSetup = (dir: string): Setup =>
  Bun.TOML.parse(readFileSync(resolve(dir, 'case.toml'), 'utf8')) as Setup;
const checkVersions = (setup: Setup) => {
  if (
    setup.versions.language !== '1.0-rc' ||
    setup.versions.costModel !== '0'
  ) {
    throw new Error(
      'Unsupported case versions; expected language 1.0-rc / Cost Model 0',
    );
  }
};

export type Divergence = {
  actual: string;
  byte: number;
  expected: string;
};
export const firstDivergence = (
  expected: string,
  actual: string,
): Divergence | undefined => {
  const encoder = new TextEncoder();
  const a = encoder.encode(expected),
    b = encoder.encode(actual);
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) {
    i++;
  }
  return i === a.length && i === b.length
    ? undefined
    : { byte: i + 1, expected, actual };
};

const separator = (line: string): number => {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      quoted = !quoted;
    } // Display-form strings have no escapes.
    if (!quoted && line.startsWith(' => ', i)) {
      return i;
    }
  }
  throw new Error('Missing encoding separator');
};

export const runEncodingCase = (
  dir: string,
): {
  count: number;
  divergence?: Divergence & { line: number; source: string };
} => {
  const setup = readSetup(dir);
  if (setup.kind !== 'encoding') {
    throw new Error(`Expected a Value Encoding case, not ${setup.kind}`);
  }
  checkVersions(setup);
  const lines = readFileSync(resolve(dir, 'case.encoding'), 'utf8').split('\n');
  let count = 0;
  for (const [index, line] of lines.entries()) {
    if (!line || line.startsWith('#')) {
      continue;
    }
    try {
      const split = separator(line);
      const source = line.slice(0, split);
      // readDisplay constructs every node through the public Host constructors.
      const value = readDisplay(source);
      const actual = encodeValue(value);
      const divergence = firstDivergence(line.slice(split + 4), actual);
      if (divergence) {
        return {
          count,
          divergence: { ...divergence, line: index + 1, source },
        };
      }
      count++;
    } catch (error) {
      throw new Error(
        `${relative(root, dir)}/case.encoding:${index + 1}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  return { count };
};

/**
 * Compile a case's Libraries, in order, then its Scripts. A Script's
 * well-known objects are its `objects` and the case's other Scripts.
 */
export const compileCase = (
  dir: string,
  setup: Setup,
): Map<string, CodeUnit> => {
  const units = new Map<string, CodeUnit>();
  const libraries: Record<string, Record<string, LibraryExport>> = {};
  const compile = (
    name: string,
    source: string,
    unit: 'script' | 'library',
    objects: string[],
  ) => {
    const checked = checkSource(readFileSync(resolve(dir, source), 'utf8'), {
      unit,
      objects,
      libraries,
    });
    if (checked.error) {
      const { code, tok } = checked.error;
      throw new Error(`${source}:${tok.line}:${tok.col}: ${code}`);
    }
    if (!checked.ok) {
      const d = checked.diagnostics[0]!;
      throw new Error(`${source}:${d.span.line}:${d.span.col}: ${d.code}`);
    }
    units.set(name, lowerTree(checked.tree, { name, unit }));
    return checked.tree;
  };
  for (const library of setup.libraries ?? []) {
    libraries[library.name] = exportsOf(
      compile(library.name, library.source, 'library', []),
    );
  }
  const scripts = setup.scripts ?? [];
  for (const script of scripts) {
    compile(script.name, script.source, 'script', [
      ...Object.keys(script.objects ?? {}),
      ...scripts.filter(other => other !== script).map(other => other.name),
    ]);
  }
  return units;
};

export type LineDivergence = Divergence & { file: string; line: number };
/** The first line two texts differ on, with its first differing byte. */
export const firstLineDivergence = (
  file: string,
  expected: string,
  actual: string,
): LineDivergence | undefined => {
  if (expected === actual) {
    return undefined;
  }
  const a = expected.split('\n');
  const b = actual.split('\n');
  let line = 0;
  while (line < Math.min(a.length, b.length) && a[line] === b[line]) {
    line++;
  }
  const divergence = firstDivergence(a[line] ?? '', b[line] ?? '')!;
  return { ...divergence, file, line: line + 1 };
};

/** Run a Disassembly Case, or with `bless` write each expected file. */
export const runDisassemblyCase = (
  dir: string,
  { bless = false } = {},
): { count: number; divergence?: LineDivergence } => {
  const setup = readSetup(dir);
  if (setup.kind !== 'disassembly') {
    throw new Error(`Expected a Disassembly Case, not ${setup.kind}`);
  }
  checkVersions(setup);
  const units = compileCase(dir, setup);
  let count = 0;
  for (const { unit, expected } of setup.disassembly ?? []) {
    const code = units.get(unit);
    if (!code) {
      throw new Error(`case.toml pins ${unit}, which the case doesn't compile`);
    }
    const actual = disassemble(code);
    const path = resolve(dir, expected);
    if (bless) {
      writeFileSync(path, actual);
    } else {
      const divergence = firstLineDivergence(
        expected,
        readFileSync(path, 'utf8'),
        actual,
      );
      if (divergence) {
        return { count, divergence };
      }
    }
    count++;
  }
  if (!count) {
    throw new Error('case.toml pins no [[disassembly]] unit');
  }
  return { count };
};

const casesUnder = (path: string): string[] => {
  if (!statSync(path).isDirectory()) {
    throw new Error(`Expected case directory: ${path}`);
  }
  const entries = readdirSync(path);
  if (entries.includes('case.toml')) {
    return [path];
  }
  return entries.sort().flatMap(name => {
    const child = resolve(path, name);
    return statSync(child).isDirectory() ? casesUnder(child) : [];
  });
};

const usage = 'Usage: corpus:run --list | [--bless] [case directory ...]';

export const runCorpus = (args: string[]): number => {
  if (args.includes('--list')) {
    if (args.length !== 1) {
      throw new Error(usage);
    }
    for (const dir of casesUnder(corpusRoot)) {
      const { kind } = readSetup(dir);
      console.log(
        `${supported.has(kind) ? 'supported' : 'deferred '} ${relative(corpusRoot, dir)}`,
      );
    }
    return 0;
  }
  const bless = args.includes('--bless');
  const paths = args.filter(arg => arg !== '--bless');
  if (paths.some(arg => arg.startsWith('--'))) {
    throw new Error(usage);
  }
  if (bless && !paths.length) {
    throw new Error('--bless needs the cases to bless');
  }
  const selected = paths.length
    ? paths.flatMap(arg => casesUnder(resolve(corpusRoot, arg)))
    : // A Trace Case runs by default once blessed; until then, only when named.
      casesUnder(corpusRoot).filter(dir => {
        const { kind } = readSetup(dir);
        return (
          supported.has(kind) &&
          !((kind === 'trace' || kind === 'transcript') && unblessed(dir))
        );
      });
  if (!selected.length) {
    throw new Error('Selection contains no cases');
  }
  let failures = 0;
  for (const dir of new Set(selected)) {
    const name = relative(corpusRoot, dir);
    try {
      const { kind } = readSetup(dir);
      if (!supported.has(kind)) {
        throw new Error(`Deferred case kind: ${kind}`);
      }
      if (kind === 'disassembly') {
        const result = runDisassemblyCase(dir, { bless });
        if (result.divergence) {
          const d = result.divergence;
          console.error(
            `FAIL ${name} (TS lowering 1.0-rc / Cost Model 0)\n  ${d.file}:${d.line}, first differing UTF-8 byte ${d.byte}\n  expected: ${d.expected}\n  actual:   ${d.actual}`,
          );
          failures++;
        } else {
          console.log(
            `${bless ? 'BLESSED' : 'PASS'} ${name} (${result.count} disassembl${result.count === 1 ? 'y' : 'ies'})`,
          );
        }
        continue;
      }
      if (kind === 'trace') {
        const setup = readSetup(dir);
        checkVersions(setup);
        const result = runTraceCase(dir, setup, { bless });
        if (result.divergence) {
          const d = result.divergence;
          console.error(
            [
              `FAIL ${name} (TS Core 1.0-rc / Cost Model 0)`,
              `  case.trace:${d.line}, after ${result.lines} matching lines`,
              ...d.context.map(line => `    ${line}`),
              `  expected: ${d.expected}`,
              `  actual:   ${d.actual}`,
            ].join('\n'),
          );
          failures++;
        } else {
          console.log(
            `${bless ? 'BLESSED' : 'PASS'} ${name} (${result.lines} lines)`,
          );
        }
        continue;
      }
      if (kind === 'transcript') {
        checkVersions(readSetup(dir));
        const result = runTranscriptCase(dir, { bless });
        if (result.divergence) {
          const d = result.divergence;
          console.error(
            [
              `FAIL ${name} (TS Session Host 1.0-rc / Cost Model 0)`,
              `  ${d.file}:${d.line}`,
              ...d.context.map(line => `    ${line}`),
              `  expected: ${d.expected}`,
              `  actual:   ${d.actual}`,
            ].join('\n'),
          );
          failures++;
        } else {
          console.log(
            `${bless ? 'BLESSED' : 'PASS'} ${name} (${result.lines} lines)`,
          );
        }
        continue;
      }
      if (bless) {
        throw new Error(
          `--bless writes Disassembly, Trace and Transcript Cases only, not ${kind}`,
        );
      }
      const result = runEncodingCase(dir);
      if (result.divergence) {
        const d = result.divergence;
        console.error(
          `FAIL ${name} (TS values 1.0-rc / Cost Model 0)\n  case.encoding:${d.line}, first differing UTF-8 byte ${d.byte}\n  value: ${d.source}\n  expected: ${d.expected}\n  actual:   ${d.actual}`,
        );
        failures++;
      } else {
        console.log(`PASS ${name} (${result.count} encodings)`);
      }
    } catch (error) {
      console.error(
        error instanceof DeferredCaseError
          ? `FAIL ${name}: deferred, since it uses ${error.message}`
          : `FAIL ${name}: ${error instanceof Error ? error.message : error}`,
      );
      failures++;
    }
  }
  return failures ? 1 : 0;
};

if (import.meta.main) {
  try {
    process.exitCode = runCorpus(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
