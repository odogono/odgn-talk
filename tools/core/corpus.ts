#!/usr/bin/env bun
// Execute implemented Corpus case kinds. This is distinct from corpus:check,
// which checks formats. No seed output is rewritten by this runner.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { encodeValue, readDisplay } from '../../src/index';

const root = resolve(import.meta.dir, '../..');
const corpusRoot = resolve(root, 'corpus');
const implemented = ['text-model/host-text-normalised-to-nfc'];
type Setup = {
  kind: string;
  versions: { costModel: string; language: string };
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
  const setup = Bun.TOML.parse(
    readFileSync(resolve(dir, 'case.toml'), 'utf8'),
  ) as Setup;
  if (setup.kind !== 'encoding') {
    throw new Error(
      `Deferred case kind: ${setup.kind}; this slice executes Value Encoding cases`,
    );
  }
  if (
    setup.versions.language !== '1.0-rc' ||
    setup.versions.costModel !== '0'
  ) {
    throw new Error(
      'Unsupported case versions; expected language 1.0-rc / Cost Model 0',
    );
  }
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

export const runCorpus = (args: string[]): number => {
  if (args.includes('--list')) {
    if (args.length !== 1) {
      throw new Error('Usage: corpus:run --list | [case directory ...]');
    }
    for (const dir of casesUnder(corpusRoot)) {
      const name = relative(corpusRoot, dir);
      console.log(
        `${implemented.includes(name) ? 'supported' : 'deferred '} ${name}`,
      );
    }
    return 0;
  }
  if (args.some(arg => arg.startsWith('--'))) {
    throw new Error('Usage: corpus:run --list | [case directory ...]');
  }
  const selected = args.length
    ? args.flatMap(arg => casesUnder(resolve(corpusRoot, arg)))
    : implemented.map(name => resolve(corpusRoot, name));
  if (!selected.length) {
    throw new Error('Selection contains no cases');
  }
  let failures = 0;
  for (const dir of new Set(selected)) {
    const name = relative(corpusRoot, dir);
    try {
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
        `FAIL ${name}: ${error instanceof Error ? error.message : error}`,
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
