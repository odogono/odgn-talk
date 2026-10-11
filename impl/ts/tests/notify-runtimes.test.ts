import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notifyKitSequences } from '../tools/notify-kit';

// The router uses no Bun API, so it runs unchanged under Node and Deno. A
// runtime that isn't on PATH is skipped, unless NORTHTALK_NOTIFY_RUNTIMES,
// a comma list, requires it.
const required = new Set(
  (process.env.NORTHTALK_NOTIFY_RUNTIMES ?? '').split(',').filter(Boolean),
);
const directory = mkdtempSync(join(tmpdir(), 'northtalk-notify-runtimes-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const bundled = async () => {
  const sequences = join(directory, 'sequences.json');
  writeFileSync(sequences, JSON.stringify(await notifyKitSequences()));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, '../tools/notify-kit-runtime.ts')],
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
    script,
    ...args,
  ],
};

for (const [name, command] of Object.entries(runtimes)) {
  test.skipIf(!required.has(name) && !Bun.which(name))(
    `the router follows the router kit under ${name}`,
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
