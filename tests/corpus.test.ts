import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runEncodingCase, firstDivergence } from '../tools/core/corpus';

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
