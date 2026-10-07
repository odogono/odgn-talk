#!/usr/bin/env bun
// Blesses named Corpus cases only when every available Core agrees, as
// chapter 11's `bless` says.
//
//   bun tools/corpus/bless.ts CASE …   CASE is relative to corpus/
//
// The TS runner writes the Disassembly, Trace or Transcript expectations
// from its own output, in both replays. The TS and Go runners must then
// each pass the written files, in both replays. If any step fails, every
// file in the case's directory is put back as it was and the first
// divergence is reported. Blessing doesn't approve a first blessing: a
// human reviews the diff and removes the `Unblessed` marker
// (corpus/README.md#seed-blessing).

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');

/** A runner command; the case name is appended as its last argument. */
export type Step = {
  command: readonly [string, ...string[]];
  name: string;
};

export type Outcome =
  | { blessed: true; name: string }
  | { blessed: false; name: string; output: string; step: string };

const snapshot = (dir: string): Map<string, Buffer> => {
  const files = new Map<string, Buffer>();
  const walk = (path: string) => {
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
      } else {
        files.set(child, readFileSync(child));
      }
    }
  };
  walk(dir);
  return files;
};

const restore = (dir: string, files: Map<string, Buffer>) => {
  for (const path of snapshot(dir).keys()) {
    if (!files.has(path)) {
      rmSync(path);
    }
  }
  for (const [path, bytes] of files) {
    writeFileSync(path, bytes);
  }
};

/**
 * Write a case's expectations with `write`, then keep them only if every
 * `check` passes them. Otherwise restore the case directory.
 */
export const blessCase = (
  root: string,
  name: string,
  write: Step,
  checks: readonly Step[],
): Outcome => {
  const dir = resolve(root, name);
  if (!existsSync(join(dir, 'case.toml'))) {
    throw new Error(`unknown case ${name}; name it relative to corpus/`);
  }
  const before = snapshot(dir);
  for (const step of [write, ...checks]) {
    const [command, ...args] = step.command;
    const result = spawnSync(command, [...args, name], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      restore(dir, before);
      return {
        blessed: false,
        name,
        output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`,
        step: step.name,
      };
    }
  }
  return { blessed: true, name };
};

const main = (names: string[]): number => {
  if (!names.length || names.some(name => name.startsWith('-'))) {
    console.error('Usage: corpus:bless CASE …');
    return 1;
  }
  const bin = mkdtempSync(join(tmpdir(), 'northtalk-bless-'));
  try {
    const go = join(bin, 'corpus');
    const build = spawnSync(
      'go',
      ['-C', 'impl/go', 'build', '-o', go, './cmd/corpus'],
      { cwd: ROOT, stdio: 'inherit' },
    );
    if (build.status !== 0) {
      console.error(
        'bless needs every available Core; the Go runner did not build',
      );
      return 1;
    }
    const ts = ['bun', 'impl/ts/tools/corpus.ts'] as const;
    const write: Step = { command: [...ts, '--bless'], name: 'TS bless' };
    const checks: Step[] = [
      { command: ts, name: 'TS Core' },
      { command: [go], name: 'Go Core' },
    ];
    let failures = 0;
    for (const name of names) {
      const outcome = blessCase(resolve(ROOT, 'corpus'), name, write, checks);
      if (outcome.blessed) {
        console.log(`BLESSED ${name} (TS and Go agree)`);
      } else {
        failures++;
        console.error(
          `NOT BLESSED ${name}: ${outcome.step} failed; the case is unchanged\n${outcome.output.trimEnd()}`,
        );
      }
    }
    return failures ? 1 : 0;
  } finally {
    rmSync(bin, { force: true, recursive: true });
  }
};

if (import.meta.main) {
  process.exitCode = main(Bun.argv.slice(2));
}
