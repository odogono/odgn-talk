import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitCatalogue } from './generate';
import { writeOutput } from './output';

test('Go catalogues preserve heterogeneous counts and optional fields', () => {
  const result = emitCatalogue('example', {
    instruction: [
      { name: 'const', pops: 0, operands: [] },
      { name: 'call', pops: 'count', operands: ['body'], jumps: 1 },
    ],
  });
  expect(result).toContain('Pops');
  expect(result).toContain('any');
  expect(result).toContain('"count"');
  expect(result).toContain('Jumps: 1');
  expect(result).toContain('[]string');
});

test('checks refuse missing and stale Go output without overwriting it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'northtalk-go-'));
  const path = join(dir, 'table.go');
  try {
    await expect(writeOutput(path, 'new', true, 'generate')).rejects.toThrow(
      'stale',
    );
    await writeFile(path, 'old');
    await expect(writeOutput(path, 'new', true, 'generate')).rejects.toThrow(
      'stale',
    );
    expect(await readFile(path, 'utf8')).toBe('old');
    await writeOutput(path, 'new', false, 'generate');
    await writeOutput(path, 'new', true, 'generate');
  } finally {
    await rm(dir, { recursive: true });
  }
});
