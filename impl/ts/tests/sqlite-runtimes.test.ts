import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteKitSequences } from '../tools/sqlite-kit';

// The implementation is node:sqlite, so it runs unchanged under Node and
// Deno. A runtime that isn't on PATH, or whose node:sqlite has no
// setAuthorizer, is skipped, unless NORTHTALK_SQLITE_RUNTIMES, a comma
// list, requires it.
const required = new Set(
  (process.env.NORTHTALK_SQLITE_RUNTIMES ?? '').split(',').filter(Boolean),
);
const AUTHORIZER =
  "import('node:sqlite').then(m => console.log(typeof m.DatabaseSync.prototype.setAuthorizer))";
const directory = mkdtempSync(join(tmpdir(), 'northtalk-sqlite-runtimes-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const bundled = async () => {
  const sequences = join(directory, 'sequences.json');
  writeFileSync(sequences, JSON.stringify(sqliteKitSequences()));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, '../tools/sqlite-kit-runtime.ts')],
    outdir: directory,
    target: 'node',
    format: 'esm',
    naming: 'kit.mjs',
  });
  expect(built.success).toBe(true);
  return { script: join(directory, 'kit.mjs'), sequences };
};

const runtimes = {
  node: (script: string, ...args: string[]) => ['node', script, ...args],
  deno: (script: string, ...args: string[]) => [
    'deno',
    'run',
    '--allow-read',
    '--allow-write',
    '--allow-env',
    script,
    ...args,
  ],
};
const supported = (name: string) => {
  if (!Bun.which(name)) {
    return false;
  }
  const command =
    name === 'node'
      ? ['node', '--input-type=module', '-e', AUTHORIZER]
      : ['deno', 'eval', AUTHORIZER];
  return Bun.spawnSync(command).stdout.toString().trim() === 'function';
};

for (const [name, command] of Object.entries(runtimes)) {
  test.skipIf(!required.has(name) && !supported(name))(
    `node:sqlite follows the sqlite test kit under ${name}`,
    async () => {
      const { script, sequences } = await bundled();
      const run = Bun.spawnSync(command(script, sequences));
      const out = run.stdout.toString();
      expect({ exit: run.exitCode, out, err: run.stderr.toString() }).toEqual({
        exit: 0,
        out: expect.stringMatching(/^(\d+) of \1 sequences passed\n$/),
        err: '',
      });
    },
    60_000,
  );
}
