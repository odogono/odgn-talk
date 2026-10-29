#!/usr/bin/env bun
// Replay the Corpus's Trace Cases through @northtalk/ts/wasm, the TS
// embedding API over the Zig reactor, as the TS Core's own runner replays
// them through the TS Core (#1121). The Host side of each case is the TS
// runner's; only the Core behind it changes, one Core per case.
//
//   bun tools/wasm-corpus.ts [--wasm path/to/talk.wasm] [--json-callbacks] [--quiet] [case …]
// Runtime checks supply --setups with pre-parsed TOML so the same runner runs on Node.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { Setup } from '../src/replay';
import { checkTraceCase } from './case-checks';
import { DeferredCaseError, reader } from './trace-case';
import { zigCaseCore } from './zig-case-core';

/** Divergences in the reactor, each with its issue; they're reported, not failed. */
const known = new Map<string, string>();

const root = resolve(
  process.env.NORTHTALK_ROOT ?? resolve(import.meta.dirname, '../../..'),
);
const corpusRoot = resolve(root, 'corpus');

const casesUnder = (path: string): string[] => {
  if (statSync(path).isFile()) {
    return [];
  }
  const entries = readdirSync(path);
  if (entries.includes('case.toml')) {
    return [path];
  }
  return entries.sort().flatMap(entry => casesUnder(resolve(path, entry)));
};

const args = process.argv.slice(2);
const at = args.indexOf('--wasm');
const wasm = resolve(
  at >= 0 ? args[at + 1]! : resolve(root, '.cache/zig-wasi/bin/talk.wasm'),
);
const quiet = args.includes('--quiet');
const setupsAt = args.indexOf('--setups');
const setups: Record<string, Setup & { kind: string }> | undefined =
  setupsAt < 0
    ? undefined
    : JSON.parse(readFileSync(args[setupsAt + 1]!, 'utf8'));
const paths = args.filter(
  (arg, i) =>
    !arg.startsWith('--') &&
    (at < 0 || i !== at + 1) &&
    (setupsAt < 0 || i !== setupsAt + 1),
);
const module = await WebAssembly.compile(readFileSync(wasm));

const caseCore = () => zigCaseCore(module, !args.includes('--json-callbacks'));

const selected = (paths.length ? paths : ['.']).flatMap(p =>
  casesUnder(resolve(corpusRoot, p)),
);
let passed = 0;
const failed: string[] = [];
const deferred: string[] = [];
const expected: string[] = [];
// A save restored through a frame past the reactor's 64 MiB limit, which an
// in-process Core never meets (chapter 9, Nesting: the transport's limit).
const beyond: string[] = [];
for (const dir of selected) {
  const name = relative(corpusRoot, dir);
  const setup =
    setups?.[name] ??
    (Bun.TOML.parse(
      readFileSync(resolve(dir, 'case.toml'), 'utf8'),
    ) as Setup & { kind: string });
  if (setup.kind !== 'trace') {
    continue;
  }
  try {
    const result = checkTraceCase(reader(dir), setup, await caseCore());
    if (result.divergence && known.has(name)) {
      expected.push(name);
      if (!quiet) {
        console.log(`KNOWN ${name}: ${known.get(name)}`);
      }
    } else if (result.divergence) {
      const d = result.divergence;
      failed.push(name);
      if (!quiet) {
        console.error(
          [
            `FAIL ${name}`,
            `  case.trace:${d.line}, after ${result.lines} matching lines`,
            ...d.context.map(line => `    ${line}`),
            `  expected: ${d.expected}`,
            `  actual:   ${d.actual}`,
          ].join('\n'),
        );
      }
    } else if (known.has(name)) {
      failed.push(name);
      console.error(`FIXED ${name}: remove it from the known divergences`);
    } else {
      passed++;
      if (!quiet) {
        console.log(`PASS ${name} (${result.lines} lines)`);
      }
    }
  } catch (error) {
    // Bundlers can duplicate this class through the package barrel and a
    // direct import. Its explicit error name also survives that boundary.
    if (error instanceof Error && error.name === 'FrameRefusedError') {
      beyond.push(name);
      if (!quiet) {
        console.log(`FRAME LIMIT ${name}: ${error.message}`);
      }
      continue;
    }
    if (error instanceof DeferredCaseError) {
      deferred.push(name);
      if (!quiet) {
        console.log(`DEFERRED ${name}: ${error.message}`);
      }
      continue;
    }
    failed.push(name);
    console.error(
      `FAIL ${name}: ${error instanceof Error ? error.message : error}`,
    );
  }
}
console.log(
  [
    `${passed} passed`,
    `${failed.length} failed`,
    `${expected.length} known divergences`,
    `${beyond.length} past the frame limit`,
    `${deferred.length} deferred by the TS runner`,
  ].join(', '),
);
if (failed.length) {
  console.log(`failed: ${failed.join(' ')}`);
}
process.exitCode = failed.length ? 1 : 0;
