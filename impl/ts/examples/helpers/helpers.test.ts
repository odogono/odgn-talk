import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The embedding guide's first example runs unchanged under Bun and Node.
// Node runs a bundle, since it won't strip types from the workspace source.
// Node is skipped when it isn't on PATH, unless NORTHTALK_EXAMPLE_RUNTIMES,
// a comma list, requires it.
const main = join(import.meta.dir, 'main.ts');
const expected = '5\n0.3\nHELLO, ADA!\n';
const directory = mkdtempSync(join(tmpdir(), 'northtalk-helpers-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const output = async (command: string[]) => {
  const run = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, exit] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  return { exit, out, err };
};

test('the Helpers example runs under Bun', async () => {
  expect(await output([process.execPath, main])).toEqual({
    exit: 0,
    out: expected,
    err: '',
  });
});

const required = (process.env.NORTHTALK_EXAMPLE_RUNTIMES ?? '').split(',');
test.skipIf(!required.includes('node') && !Bun.which('node'))(
  'the Helpers example runs under Node',
  async () => {
    const built = await Bun.build({
      entrypoints: [main],
      outdir: directory,
      target: 'node',
      format: 'esm',
      naming: 'main.mjs',
    });
    expect(built.success).toBe(true);
    expect(await output(['node', join(directory, 'main.mjs')])).toEqual({
      exit: 0,
      out: expected,
      err: '',
    });
  },
  60_000,
);
