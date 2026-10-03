import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from '../src/generator';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const run = (...args: string[]) => {
  const result = Bun.spawnSync([process.execPath, cli, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

test('smoke writes a summary and exits 0 without findings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'northtalk-fuzz-cli-'));
  try {
    const result = run(
      'smoke',
      '--seed',
      '1',
      '--count',
      '2',
      '--profile',
      'compute',
      '--output',
      dir,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).completed).toBe(2);
    expect(
      JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')).seed,
    ).toBe('1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reproduce reruns a saved case and minimize refuses a case with no finding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'northtalk-fuzz-cli-'));
  try {
    const path = join(dir, 'case.json');
    await writeFile(
      path,
      JSON.stringify(generate('1', { features: ['compute'], witness: true })),
    );
    const reproduced = run('reproduce', path);
    expect(reproduced.code).toBe(0);
    expect(JSON.parse(reproduced.stdout)).toEqual([]);
    const minimized = run(
      'minimize',
      path,
      '--output',
      join(dir, 'minimized.json'),
    );
    expect(minimized.code).toBe(1);
    expect(minimized.stderr).toContain('no finding');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid arguments exit 2 with usage', () => {
  for (const args of [
    [],
    ['explode'],
    ['smoke', '--count', 'many'],
    ['smoke', '--profile', 'teleport'],
    ['reproduce'],
  ]) {
    const result = run(...args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Usage:');
  }
});
