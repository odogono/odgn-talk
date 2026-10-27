// `bun run bench:compare`: times the TS Core on a base revision and on this
// tree, alternating the order each round, and prints the change per Benchmark.
// The base is checked out once into .cache/bench-compare and reused. See
// bench/README.md#comparing-a-branch-with-main.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { median, type Measurement } from './report';

const { positionals, values: flags } = parseArgs({
  allowPositionals: true,
  options: {
    filter: { default: '', type: 'string' },
    node: { default: false, type: 'boolean' },
    rounds: { default: '3', type: 'string' },
  },
});
const ref = positionals[0] ?? 'origin/main';
const rounds = Number(flags.rounds);
const head = resolve(import.meta.dirname, '../../..');
const baseDir = join(head, '.cache', 'bench-compare', 'base');

const sh = (cmd: string[], cwd: string) => {
  const result = spawnSync(cmd[0]!, cmd.slice(1), {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  if (result.status !== 0) {
    console.error(`${cmd.join(' ')} failed:\n${result.stdout}${result.stderr}`);
    process.exit(1);
  }
  return result.stdout.trim();
};

if (ref.startsWith('origin/')) {
  sh(['git', 'fetch', '-q', 'origin', ref.slice('origin/'.length)], head);
}
const sha = sh(['git', 'rev-parse', '--verify', `${ref}^{commit}`], head);
if (existsSync(baseDir)) {
  sh(['git', 'checkout', '-q', '--detach', sha], baseDir);
} else {
  mkdirSync(dirname(baseDir), { recursive: true });
  sh(['git', 'worktree', 'add', '-q', '--detach', baseDir, sha], head);
}
console.error(`Base ${ref} (${sha.slice(0, 8)}) in ${baseDir}`);
sh(['bun', 'install', '--frozen-lockfile'], baseDir);

// The Node build swaps Bun's heap probe for a stub and fixes each bench
// source's own directory, so either tree's runner bundles unchanged.
const nodeBuild = async (tree: string) => {
  const outdir = join(tree, 'bench', 'ts', 'dist');
  const result = await Bun.build({
    entrypoints: [join(tree, 'bench', 'ts', 'src', 'measure-ts.ts')],
    naming: 'compare-measure-ts.js',
    outdir,
    target: 'node',
    plugins: [
      {
        name: 'node-runner',
        setup(build) {
          build.onResolve({ filter: /^bun:jsc$/ }, () => ({
            namespace: 'stub',
            path: 'bun:jsc',
          }));
          build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents: 'export const memoryUsage = () => ({ current: 0 });',
            loader: 'js',
          }));
          build.onLoad({ filter: /bench\/ts\/src\/[^/]+\.ts$/ }, async args => {
            const dir = JSON.stringify(dirname(args.path));
            return {
              contents: (await Bun.file(args.path).text())
                .replaceAll('import.meta.dirname', dir)
                .replaceAll('import.meta.dir', dir),
              loader: 'ts',
            };
          });
        },
      },
    ],
  });
  if (!result.success) {
    console.error(result.logs.join('\n'));
    process.exit(1);
  }
  return join(outdir, 'compare-measure-ts.js');
};

const runtimes: { command: (tree: string) => string[]; name: string }[] = [
  {
    name: 'bun',
    command: tree => ['bun', join(tree, 'bench/ts/src/measure-ts.ts')],
  },
];
if (flags.node) {
  const built = { base: await nodeBuild(baseDir), head: await nodeBuild(head) };
  runtimes.push({
    name: 'node',
    command: tree => ['node', tree === head ? built.head : built.base],
  });
}

type Side = 'base' | 'head';
// runtime → benchmark → phase → side → each round's median
const times = new Map<
  string,
  Map<string, Record<string, Record<Side, number[]>>>
>();
const record = (runtime: string, side: Side, ms: Measurement[]) => {
  const byBenchmark = times.get(runtime) ?? new Map();
  times.set(runtime, byBenchmark);
  for (const m of ms) {
    const phases = byBenchmark.get(m.benchmark) ?? {};
    byBenchmark.set(m.benchmark, phases);
    for (const [phase, stats] of [
      ['load', m.load],
      ['run', m.run],
    ] as const) {
      if (!stats) {
        continue;
      }
      phases[phase] ??= { base: [], head: [] };
      phases[phase][side].push(stats.medianNs);
    }
  }
};

for (let round = 0; round < rounds; round++) {
  const order: Side[] = round % 2 ? ['head', 'base'] : ['base', 'head'];
  for (const runtime of runtimes) {
    for (const side of order) {
      console.error(`Round ${round + 1}/${rounds}: ${runtime.name} ${side}`);
      const tree = side === 'head' ? head : baseDir;
      const out = sh([...runtime.command(tree), flags.filter], tree);
      record(runtime.name, side, JSON.parse(out) as Measurement[]);
    }
  }
}

const ms = (ns: number) => (ns / 1e6).toFixed(ns < 1e7 ? 3 : 1);
const range = (xs: number[]) => `${ms(Math.min(...xs))}–${ms(Math.max(...xs))}`;
console.log(
  `Base ${ref} (${sha.slice(0, 8)}) against this tree, ${rounds} alternating rounds. Times are the median of each round's median, in ms; runs vary by ±5–8%, so a smaller change is noise.\n`,
);
console.log(
  '| Runtime | Benchmark | Phase | Base | Head | Change | Base range | Head range |',
);
console.log('|---|---|---|--:|--:|--:|--:|--:|');
for (const [runtime, byBenchmark] of times) {
  for (const [benchmark, phases] of byBenchmark) {
    for (const [phase, { base, head: after }] of Object.entries(phases)) {
      const change = (median(after) / median(base) - 1) * 100;
      const flag = Math.abs(change) < 8 ? ' (noise)' : '';
      console.log(
        `| ${runtime} | ${benchmark} | ${phase} | ${ms(median(base))} | ${ms(median(after))} | ${change > 0 ? '+' : ''}${change.toFixed(1)}%${flag} | ${range(base)} | ${range(after)} |`,
      );
    }
  }
}
