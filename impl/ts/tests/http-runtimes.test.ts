import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { httpKitCases } from '../tools/http-kit';

// The HTTP router uses node:http and no Bun API, so it runs unchanged under
// Node. Node is skipped when it isn't on PATH, unless NORTHTALK_HTTP_RUNTIMES,
// a comma list, requires it.
const required = new Set(
  (process.env.NORTHTALK_HTTP_RUNTIMES ?? '').split(',').filter(Boolean),
);
const directory = mkdtempSync(join(tmpdir(), 'northtalk-http-runtimes-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const bundled = async () => {
  const cases = join(directory, 'cases.json');
  writeFileSync(cases, JSON.stringify(await httpKitCases()));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, '../tools/http-kit-runtime.ts')],
    outdir: directory,
    target: 'node',
    format: 'esm',
    naming: 'kit.mjs',
  });
  expect(built.success).toBe(true);
  return { script: join(directory, 'kit.mjs'), cases };
};

const runtimes = {
  node: (script: string, ...args: string[]) => ['node', script, ...args],
};

for (const [name, command] of Object.entries(runtimes)) {
  test.skipIf(!required.has(name) && !Bun.which(name))(
    `the HTTP router follows the http test kit under ${name}`,
    async () => {
      const { script, cases } = await bundled();
      const run = Bun.spawn(command(script, cases), {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [out, err, exit] = await Promise.all([
        new Response(run.stdout).text(),
        new Response(run.stderr).text(),
        run.exited,
      ]);
      expect({ exit, out, err }).toEqual({
        exit: 0,
        out: expect.stringMatching(/^(\d+) of \1 cases passed\n$/),
        err: '',
      });
    },
    60_000,
  );
}
