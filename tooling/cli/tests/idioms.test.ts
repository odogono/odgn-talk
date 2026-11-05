// Runs every example in docs/idioms.md through the Script Runner. Each `talk`
// block is a Handler body; its `-->` lines are what it says, in order.
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const main = resolve(import.meta.dir, '../src/main.ts');
const page = readFileSync(
  resolve(import.meta.dir, '../../../docs/idioms.md'),
  'utf8',
);
const blocks = [...page.matchAll(/```talk\n([\S\s]*?)```/g)].map(m => m[1]!);

test('docs/idioms.md has examples', () => {
  expect(blocks.length).toBeGreaterThan(0);
});

blocks.forEach((block, i) => {
  const lines = block.trimEnd().split('\n');
  test(`idioms example ${i + 1}: ${lines[0]}`, () => {
    const expected = lines
      .filter(l => l.startsWith('--> '))
      .map(l => l.slice(4));
    const body = lines.filter(l => !l.startsWith('--> '));
    const source = ['on start args', ...body.map(l => `  ${l}`), 'end start'];
    const directory = mkdtempSync(join(tmpdir(), 'northtalk-idioms-'));
    try {
      const file = join(directory, 'idiom.talk');
      writeFileSync(file, `${source.join('\n')}\n`);
      const result = spawnSync(process.execPath, [main, file], {
        encoding: 'utf8',
        timeout: 20_000,
      });
      expect({ code: result.status, stderr: result.stderr }).toEqual({
        code: 0,
        stderr: '',
      });
      expect(result.stdout.trimEnd().split('\n')).toEqual(expected);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
