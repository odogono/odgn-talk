// Native talk.h Host; builds happen before any measurements.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Measurement, statsOf } from './report';
import { manifest, scriptsDir, selected, sizeOf } from './suite';

const [filter, smokeFlag, countFlag = '10'] = process.argv.slice(2);
const smoke = smokeFlag === 'smoke';
const root = join(scriptsDir, '../..');
const output = join(root, '.cache/bench-zig');
mkdirSync(output, { recursive: true });
const exec = (args: string[], cwd = root) => {
  const result = Bun.spawnSync(args, { cwd, stderr: 'inherit' });
  if (result.exitCode !== 0) {
    throw new Error(`${args.join(' ')} failed`);
  }
  return result.stdout.toString();
};
exec(['zig', 'build'], join(root, 'impl/zig'));
const binary = join(output, 'host');
exec([
  'cc',
  '-std=c11',
  '-O2',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-Iimpl/zig/include',
  'bench/zig/host.c',
  'impl/zig/zig-out/lib/libtalk.a',
  // libtalk.a isn't position-independent, and Linux toolchains link PIE by
  // default.
  ...(process.platform === 'linux' ? ['-no-pie'] : []),
  '-o',
  binary,
]);
const measurements: Measurement[] = [];
for (const b of manifest().filter(b => selected(b, filter) && !b.skip?.zig)) {
  const size = sizeOf(b, smoke);
  const raw = JSON.parse(
    exec([
      binary,
      join(scriptsDir, `${b.script ?? b.name}.talk`),
      String(size.n),
      size.expect,
      String(b.slice ?? 0),
      smoke ? '1' : countFlag,
      smoke ? '1' : '0',
    ]),
  ) as { fuel: number; load: number[]; logicalAlloc: number; run: number[] };
  measurements.push({
    benchmark: b.name,
    runner: 'zig',
    fuel: raw.fuel,
    logicalAlloc: raw.logicalAlloc,
    load: statsOf(raw.load),
    run: statsOf(raw.run),
  });
}
console.log(JSON.stringify(measurements));
