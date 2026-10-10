import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emitCatalogue, emitOpcodes, emitStandardLibraries } from './generate';
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

test('Go opcodes follow the machine table order', () => {
  const result = emitOpcodes([{ name: 'const' }, { name: 'call-value-wait' }]);
  expect(result).toMatch(/OpConst Opcode = iota\n\tOpCallValueWait\n\)/);
  expect(() =>
    emitOpcodes(Array.from({ length: 257 }, (_, i) => ({ name: `op${i}` }))),
  ).toThrow('uint8');
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

test('embedded Standard Library sources preserve exact text and deterministic order', () => {
  const source = 'constant t = "quote & \\ backslash"\n';
  const output = emitStandardLibraries({ z: source, a: 'constant n = 1\n' });
  expect(output.indexOf('"a":')).toBeLessThan(output.indexOf('"z":'));
  const encoded = output.match(/"z":\s*("(?:[^"\\]|\\.)*")/)![1]!;
  expect(JSON.parse(encoded)).toBe(source);
});
