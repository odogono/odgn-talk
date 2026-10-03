import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('the fmt CLI runs under both Node and Bun', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'northtalk-node-format-'));
  try {
    const main = join(dir, 'main.mjs');
    const file = join(dir, 'script.talk');
    const source = 'on go\nsay 1+2\nend go';
    const formatted = 'on go\n  say 1 + 2\nend go';
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, '../src/main.ts')],
      target: 'node',
    });
    expect(build.success).toBe(true);
    writeFileSync(main, await build.outputs[0]!.text());
    for (const runtime of ['node', process.execPath]) {
      const run = (args: string[], stdin = '') => {
        const result = Bun.spawnSync([runtime, main, 'fmt', ...args], {
          stdin: new TextEncoder().encode(stdin),
        });
        return {
          code: result.exitCode,
          stdout: result.stdout.toString(),
          stderr: result.stderr.toString(),
        };
      };
      expect(run(['-'], source)).toEqual({
        code: 0,
        stdout: formatted,
        stderr: '',
      });
      writeFileSync(file, source);
      expect(run(['--check', file]).code).toBe(1);
      expect(readFileSync(file, 'utf8')).toBe(source);
      expect(run([file]).code).toBe(0);
      expect(readFileSync(file, 'utf8')).toBe(formatted);
      expect(run(['--check', file]).code).toBe(0);
      const broken = '  on go\n say 1+ into x\nend go';
      writeFileSync(file, broken);
      expect(run([file]).code).toBe(1);
      expect(readFileSync(file, 'utf8')).toBe(broken);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
