import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  firstDivergence,
  firstLineDivergence,
  runDisassemblyCase,
  runEncodingCase,
} from '../tools/core/corpus';

test('the NFC encoding seed case executes every line through the public values', () => {
  const dir = resolve(
    import.meta.dir,
    '../corpus/text-model/host-text-normalised-to-nfc',
  );
  const result = runEncodingCase(dir);
  expect(result.count).toBe(5);
  expect(result.divergence).toBeUndefined();
});

test('divergence output identifies the first byte and retains both outputs', () => {
  expect(firstDivergence('"é"', '"e"')).toEqual({
    byte: 2,
    expected: '"é"',
    actual: '"e"',
  });
  expect(firstDivergence('a', 'ab')).toEqual({
    byte: 2,
    expected: 'a',
    actual: 'ab',
  });
  expect(firstDivergence('same', 'same')).toBeUndefined();
});

test('encoding selection reports the first differing source line', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'northtalk-encoding-'));
  try {
    writeFileSync(
      resolve(dir, 'case.toml'),
      'kind = "encoding"\n[versions]\nlanguage = "1.0-rc"\ncostModel = "0"\n',
    );
    writeFileSync(
      resolve(dir, 'case.encoding'),
      '# test case\n" => " => " => "\n"é" => "wrong"\n"x" => "also wrong"\n',
    );
    expect(runEncodingCase(dir)).toEqual({
      count: 1,
      divergence: {
        line: 3,
        byte: 2,
        source: '"é"',
        expected: '"wrong"',
        actual: '"é"',
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selecting a deferred case exits with a clear failure', () => {
  const runner = resolve(import.meta.dir, '../tools/core/corpus.ts');
  const result = Bun.spawnSync([
    process.execPath,
    runner,
    'text-model/nfc-at-join-seams',
  ]);
  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain(
    'Deferred case kind: trace',
  );
});

test('every Disassembly Case reproduces its expected text byte for byte', () => {
  for (const name of [
    'expressions',
    'containers',
    'destructuring',
    'errors-and-loops',
    'calls-and-lambdas',
    'messages-and-waiting',
  ]) {
    const result = runDisassemblyCase(
      resolve(import.meta.dir, '../corpus/disassembly', name),
    );
    expect(result.divergence).toBeUndefined();
    expect(result.count).toBeGreaterThan(0);
  }
});

test('a Disassembly divergence names the first differing line and byte', () => {
  expect(
    firstLineDivergence('a.dis', 'unit a\n  0 1\n', 'unit a\n  0 2\n'),
  ).toEqual({
    file: 'a.dis',
    line: 2,
    byte: 5,
    expected: '  0 1',
    actual: '  0 2',
  });
  const dir = mkdtempSync(resolve(tmpdir(), 'northtalk-disassembly-'));
  try {
    cpSync(resolve(import.meta.dir, '../corpus/disassembly/containers'), dir, {
      recursive: true,
    });
    const expected = resolve(dir, 'writes.dis');
    const blessed = readFileSync(expected, 'utf8');
    writeFileSync(
      expected,
      blessed.replace('chunk-set item', 'chunk-set word'),
    );
    const result = runDisassemblyCase(dir);
    expect(result.divergence?.file).toBe('writes.dis');
    expect(result.divergence?.actual).toContain('chunk-set item');
    expect(result.divergence?.expected).toContain('chunk-set word');
    // Blessing writes the Core's text back.
    expect(runDisassemblyCase(dir, { bless: true }).count).toBe(1);
    expect(readFileSync(expected, 'utf8')).toBe(blessed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('blessing refuses case kinds this Core does not bless', () => {
  const runner = resolve(import.meta.dir, '../tools/core/corpus.ts');
  const result = Bun.spawnSync([
    process.execPath,
    runner,
    '--bless',
    'text-model/host-text-normalised-to-nfc',
  ]);
  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain(
    '--bless writes Disassembly Cases only',
  );
});
