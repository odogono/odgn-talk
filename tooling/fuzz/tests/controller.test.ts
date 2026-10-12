import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker, evaluate, campaign, withWatchdog } from '../src/controller';
import { generate } from '../src/generator';

test('reused worker runs cases with fresh Host state and saved cases replay independently of choices', async () => {
  const worker = new Worker();
  try {
    const c = generate('1', { features: ['compute'], witness: true });
    const first = await evaluate(c, worker);
    c.choices.scripts = [];
    const again = await evaluate(c, worker);
    expect(again.execution?.trace).toEqual(first.execution?.trace);
    expect(again.findings).toEqual([]);
  } finally {
    worker.close();
  }
});

test('watchdog terminates a stalled operation and a healthy worker can still execute', async () => {
  let stopped = false;
  await expect(
    withWatchdog(new Promise(() => {}), 10, () => {
      stopped = true;
    }),
  ).rejects.toThrow('timeout');
  expect(stopped).toBe(true);
  const healthy = new Worker();
  try {
    expect(
      (
        await evaluate(
          generate('1', { features: ['compute'], witness: true }),
          healthy,
        )
      ).findings,
    ).toEqual([]);
  } finally {
    healthy.close();
  }
});

test('late output from a stopped worker cannot answer its replacement request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'northtalk-fuzz-'));
  const entrypoint = join(dir, 'worker.ts');
  await writeFile(
    entrypoint,
    `import { createInterface } from 'node:readline';
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300));
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.type === 'capabilities') {
    setTimeout(() => console.log(JSON.stringify({
      version: 1, features: ['compute'], languageVersion: '1.0-rc.2', costModel: '0'
    })), 200);
  } else {
    setTimeout(() => {
      console.log(JSON.stringify({ findings: [] }));
      process.exit(0);
    }, 100);
  }
}
`,
  );
  const worker = new Worker({ entrypoint });
  const c = generate('1', { features: ['compute'], witness: true });
  try {
    await worker.supports(c, 2000);
    await expect(worker.request({ type: 'run' }, 10)).rejects.toThrow(
      'timeout',
    );
    expect(await worker.supports(c, 2000)).toMatchObject({
      version: 1,
      features: ['compute'],
    });
  } finally {
    worker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('smoke campaign completes its requested count and writes reproducible metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'northtalk-fuzz-'));
  try {
    const summary = await campaign({
      mode: 'smoke',
      count: 2,
      seed: '1',
      output: dir,
      budgetMs: 30_000,
      profile: ['compute'],
    });
    expect(summary.completed).toBe(2);
    expect(summary.findings).toBe(0);
    expect(
      JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')).seed,
    ).toBe('1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a case cut short by the search budget is not reported as a Worker timeout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'northtalk-fuzz-'));
  try {
    const summary = await campaign({
      mode: 'smoke',
      count: 1000,
      seed: '1',
      output: dir,
      budgetMs: 1000,
      profile: ['compute'],
    });
    expect(summary.completed).toBeLessThan(1000);
    expect(summary.findings).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
