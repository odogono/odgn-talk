// `bun run bench:profile:zig <benchmark> [--base origin/main]`: samples the
// native Zig Core running one Benchmark with macOS `sample`, and prints the
// hottest frames by self time. `--base` profiles that revision too, from a
// detached worktree in .cache/bench-base, for a side-by-side read. Full
// `sample` reports stay in .cache/prof. See bench/README.md#profiling.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { manifest, scriptsDir, sizeOf } from './suite';

const { positionals, values: flags } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: 'string' },
    seconds: { default: '6', type: 'string' },
    top: { default: '25', type: 'string' },
  },
});
if (process.platform !== 'darwin') {
  throw new Error('bench:profile:zig uses macOS `sample`');
}
const name = positionals[0];
const benchmark = manifest().find(b => b.name === name);
if (!benchmark) {
  throw new Error(`usage: bench:profile:zig <benchmark>, e.g. core/loop`);
}
const root = resolve(import.meta.dirname, '../../..');
const out = join(root, '.cache/prof');
mkdirSync(out, { recursive: true });

const run = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' });

// Builds the Core in `tree` and links bench/zig/host.c from this checkout
// against it, as measure-zig.ts does, keeping symbols for `sample`.
const build = (tree: string, label: string) => {
  run('zig', ['build'], join(tree, 'impl/zig'));
  const binary = join(out, `host-${label}`);
  run(
    'zig',
    [
      'cc',
      '-std=c11',
      '-O2',
      '-g',
      `-I${join(tree, 'impl/zig/include')}`,
      join(root, 'bench/zig/host.c'),
      join(tree, 'impl/zig/zig-out/lib/libtalk.a'),
      '-o',
      binary,
    ],
    root,
  );
  return binary;
};

const profile = async (binary: string, label: string) => {
  const size = sizeOf(benchmark, false);
  const script = join(scriptsDir, `${benchmark.script ?? benchmark.name}.talk`);
  // A count far past the sampling window; the host is killed afterwards.
  const host = spawn(
    binary,
    [
      script,
      String(size.n),
      size.expect,
      String(benchmark.slice ?? 0),
      '1000000',
      '0',
    ],
    { stdio: 'ignore' },
  );
  await new Promise(r => setTimeout(r, 1500));
  const file = join(out, `${name!.replaceAll('/', '-')}-${label}.txt`);
  try {
    run(
      'sample',
      [String(host.pid), flags.seconds!, '-mayDie', '-file', file],
      root,
    );
  } finally {
    host.kill();
  }
  const text = readFileSync(file, 'utf8');
  const top = text
    .slice(text.indexOf('Sort by top of stack'))
    .split('\n')
    .slice(1, Number(flags.top) + 1);
  const end = top.findIndex(line => !line.trim());
  const rows = (end === -1 ? top : top.slice(0, end)).join('\n');
  process.stdout.write(`== ${label} (${file})\n${rows}\n\n`);
};

await profile(build(root, 'branch'), 'branch');
if (flags.base) {
  const tree = join(root, '.cache/bench-base');
  if (!existsSync(tree)) {
    run('git', ['worktree', 'add', '-q', '--detach', tree, flags.base], root);
  } else {
    run('git', ['fetch', '-q', 'origin'], tree);
    run('git', ['checkout', '-q', '--detach', flags.base], tree);
  }
  await profile(build(tree, 'base'), 'base');
}
