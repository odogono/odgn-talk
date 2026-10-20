#!/usr/bin/env bun
// Private intrinsics cannot be invoked by ordinary Corpus Script source.
// Run the internal Hosts together; --update is atomic and is not human approval.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const dir = resolve(root, 'corpus/restricted-kit');
const update = process.argv.includes('--update');
const expectations = () =>
  readdirSync(dir).filter(f => /\.(trace|dis)$/.test(f));
const before = new Map(
  expectations().map(f => [f, readFileSync(resolve(dir, f))]),
);
const steps = [
  {
    cwd: root,
    command: ['bun', 'test', 'impl/ts/tests/restricted-callbacks.test.ts'],
  },
  { cwd: resolve(root, 'impl/zig'), command: ['zig', 'build', 'test'] },
];
let passed = false;
try {
  for (const [i, { cwd, command }] of steps.entries()) {
    const [exe, ...args] = command;
    const result = spawnSync(exe!, args, {
      cwd,
      env: {
        ...process.env,
        UPDATE_RESTRICTED_KIT: update && i === 0 ? '1' : '',
      },
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      throw new Error(`${command.join(' ')} failed`);
    }
  }
  passed = true;
  console.log(
    'Restricted callback kit agrees on TS and Zig. Expectation changes require separate human review.',
  );
} finally {
  if (update && !passed) {
    for (const f of expectations()) {
      if (!before.has(f)) {
        rmSync(resolve(dir, f));
      }
    }
    for (const [f, bytes] of before) {
      writeFileSync(resolve(dir, f), bytes);
    }
    console.error('Restored previous restricted-kit expectations.');
  }
}
