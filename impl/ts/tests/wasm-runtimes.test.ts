import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { readSetup } from '../tools/corpus';
import { callbackScenario } from '../tools/wasm-callbacks';
import { artifact } from './reactor-artifact';

const root = resolve(import.meta.dirname, '../../..');
const directory = mkdtempSync(join(tmpdir(), 'northtalk-wasm-runtimes-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
let expected: Awaited<ReturnType<typeof callbackScenario>>;
beforeAll(async () => {
  if (!existsSync(artifact)) {
    return;
  }
  expected = await callbackScenario(readFileSync(artifact), true);
  for (const [entry, name] of [
    ['tests/fixtures/wasm-callbacks-runtime.ts', 'callbacks.mjs'],
    ['tools/wasm-corpus.ts', 'corpus.mjs'],
  ]) {
    const built = await Bun.build({
      entrypoints: [resolve(import.meta.dirname, '..', entry!)],
      target: 'node',
      format: 'esm',
      outdir: directory,
      naming: name,
    });
    expect(built.success).toBe(true);
  }
  const corpus = join(root, 'corpus');
  const setups = Object.fromEntries(
    readdirSync(corpus, { recursive: true, encoding: 'utf8' })
      .filter(path => path.endsWith('/case.toml'))
      .map(path => [
        relative(corpus, resolve(corpus, path, '..')),
        readSetup(join(corpus, path, '..')),
      ]),
  );
  writeFileSync(join(directory, 'setups.json'), JSON.stringify(setups));
});

for (const runtime of ['bun', 'node']) {
  for (const mode of ['binary', 'json']) {
    const skip = !existsSync(artifact) || !Bun.which(runtime);
    test.skipIf(skip)(`WASM callbacks under ${runtime}, ${mode}`, async () => {
      const child = Bun.spawn(
        [runtime, join(directory, 'callbacks.mjs'), artifact, mode],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const [out, err, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ exit, err }).toEqual({ exit: 0, err: '' });
      expect(JSON.parse(out)).toEqual(expected);
    });
    test.skipIf(skip)(
      `WASM Corpus under ${runtime}, ${mode}`,
      async () => {
        const child = Bun.spawn(
          [
            runtime,
            join(directory, 'corpus.mjs'),
            '--wasm',
            artifact,
            '--setups',
            join(directory, 'setups.json'),
            '--quiet',
            ...(mode === 'json' ? ['--json-callbacks'] : []),
          ],
          {
            env: { ...process.env, NORTHTALK_ROOT: root },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const [out, err, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ exit, out, err }).toEqual({
          exit: 0,
          out: expect.stringMatching(
            /^\d+ passed, 0 failed, 0 known divergences, \d+ past the frame limit, 0 deferred by the TS runner\n$/,
          ),
          err: '',
        });
      },
      120_000,
    );
  }
}
