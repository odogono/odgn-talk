import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, evaluate } from '../src/controller';
import { generate, witnesses } from '../src/generator';
import type { Result } from '../src/model';

// The Go worker is built as tooling/fuzz/README.md describes; CI sets up Go.
const module = fileURLToPath(new URL('../../../impl/go', import.meta.url));
let dir: string;
let runner: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'northtalk-fuzz-go-'));
  runner = join(dir, 'fuzzworker');
  const built = spawnSync(
    'go',
    ['-C', module, 'build', '-o', runner, './cmd/fuzzworker'],
    { encoding: 'utf8' },
  );
  if (built.status !== 0) {
    throw new Error(`go build failed: ${built.error ?? built.stderr}`);
  }
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('the Go worker reports the TS worker capabilities', async () => {
  const ts = new Worker();
  const go = new Worker({ entrypoint: runner, native: true });
  try {
    const request = { type: 'capabilities' };
    expect(await go.request(request)).toEqual(await ts.request(request));
  } finally {
    ts.close();
    go.close();
  }
});

test('witnesses and mutations give identical complete Traces on both Cores', async () => {
  const ts = new Worker();
  const go = new Worker({ entrypoint: runner, native: true });
  try {
    const cases = [
      ...witnesses(),
      ...(
        [
          'wrong-mode',
          'after-suspension',
          'bad-suffixes',
          'missing-grant',
          'impure-guard',
        ] as const
      ).map(mutation => generate('1', { mutation })),
    ];
    for (const c of cases) {
      const result = (await evaluate(c, ts, go)) as Result & { peer?: Result };
      expect(result.findings).toEqual([]);
      expect(result.peer?.execution?.trace).toEqual(result.execution!.trace);
    }
  } finally {
    ts.close();
    go.close();
  }
}, 60_000);
