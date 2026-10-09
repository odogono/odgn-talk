import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { peersDir } from '../src/peers';
import type { Measurement } from '../src/report';
import { type Benchmark, manifest } from '../src/suite';

const portable = manifest().filter(b => !b.skip?.peers);

// Runs the AppleScript runner at the smoke sizes, on another manifest if given.
const smoke = (benchmarks?: Benchmark[]) => {
  const args = ['', 'smoke', '1'];
  if (benchmarks) {
    const path = join(mkdtempSync(join(tmpdir(), 'bench-')), 'manifest.json');
    writeFileSync(path, JSON.stringify({ benchmarks }));
    args.push(path);
  }
  const result = Bun.spawnSync(['osascript', 'measure.applescript', ...args], {
    cwd: join(peersDir, 'applescript'),
    stderr: 'pipe',
    stdout: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
};

describe.skipIf(platform() !== 'darwin')('applescript', () => {
  test("every port produces the Script's expected output", () => {
    const result = smoke();
    expect(result.stderr).toBe('');
    const measured = (JSON.parse(result.stdout) as Measurement[]).map(
      m => m.benchmark,
    );
    expect(measured).toEqual(portable.map(b => b.name));
  });

  test('a wrong expected output fails the check', () => {
    const b = portable[0]!;
    const wrong = `${b.smoke.expect}0`;
    const result = smoke([{ ...b, smoke: { ...b.smoke, expect: wrong } }]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`expected ${wrong}`);
  });

  test('a missing port fails the check', () => {
    const result = smoke([{ ...portable[0]!, name: 'core/absent' }]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('core/absent on applescript');
  });
});
