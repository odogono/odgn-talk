// Paired collection measurements, substituting only the optimized modules
// from the supplied revision. Each variant runs in a fresh Bun process.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { arch, cpus, loadavg, platform } from 'node:os';
import { resolve } from 'node:path';
import { manifest, sourceOf, type RunReport } from './suite';

const [
  base = 'HEAD',
  destination = '.cache/ts-collections',
  filter = '',
  first = 'before',
] = process.argv.slice(2);
if (first !== 'before' && first !== 'after') {
  throw new Error('First variant must be before or after');
}
const root = resolve(import.meta.dir, '../../..');
const out = resolve(destination);
mkdirSync(out, { recursive: true });
const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.error?.message);
  }
  return result.stdout;
};
const paths = ['impl/ts/src/list-storage.ts', 'impl/ts/src/operations.ts'];
const baseline = new Map(
  paths.map(path => [
    resolve(root, path),
    run('git', ['show', `${base}:${path}`]),
  ]),
);
const bundles: Record<string, string> = {};
const sha = (source: string) =>
  new Bun.CryptoHasher('sha256').update(source).digest('hex');
for (const variant of ['before', 'after']) {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, 'character-indexing-worker.ts')],
    target: 'bun',
    sourcemap: 'inline',
    plugins: [
      {
        name: 'collection-baseline',
        setup(build) {
          build.onLoad({ filter: /\/suite\.ts$/ }, args => ({
            contents: readFileSync(args.path, 'utf8').replaceAll(
              'import.meta.dir',
              JSON.stringify(import.meta.dir),
            ),
            loader: 'ts',
          }));
          if (variant === 'before') {
            build.onLoad(
              { filter: /\/impl\/ts\/src\/(list-storage|operations)\.ts$/ },
              args => ({ contents: baseline.get(args.path)!, loader: 'ts' }),
            );
          }
        },
      },
    ],
  });
  if (!result.success) {
    throw new Error(result.logs.join('\n'));
  }
  const path = resolve(out, `${variant}.js`);
  await Bun.write(path, result.outputs[0]!);
  bundles[variant] = path;
}
const names = new Set([
  'collections/list-update',
  'collections/list-build',
  'collections/list-append',
  'collections/iterate',
  'collections/map-update',
  'macro/transform',
]);
// Retain a Load-time List so scaling measures writes rather than construction.
const probes = [1, 32, 33, 512, 8192].flatMap(size =>
  [...new Set([1, size])].map(index => ({
    name: `probe/list-replace-${size}-${index}`,
    n: 128,
    expect: String(index + 128),
    source: `script variable seed = [${Array.from({ length: size }, (_, i) => i + 1).join(', ')}]
on run n
  put seed into values
  repeat for each i in 1..n
    put i into item ${index} of values
  end repeat
  return item ${index} of seed + item ${index} of values
end run`,
  })),
);
const workloads = [
  ...manifest()
    .filter(b => names.has(b.name))
    .map(b => ({ ...b, source: sourceOf(b) })),
  ...probes,
].filter(b => !filter || b.name.includes(filter));
if (!workloads.length) {
  throw new Error(`Unknown workload ${filter}`);
}
const input = resolve(out, 'workloads.json');
await Bun.write(input, JSON.stringify(workloads, null, 2));
const measure = (variant: string, mode: string, name: string) =>
  JSON.parse(run(process.execPath, [bundles[variant]!, input, mode, name])) as {
    checked: RunReport;
    load: number[];
    name: string;
    run: { ns: number; runs: number }[];
  }[];
const started = new Date().toISOString();
const startingLoad = loadavg();
const records = [];
const expected = new Map<string, string>();
for (const b of workloads) {
  process.stderr.write(`Paired processes: ${b.name}\n`);
  for (let round = 1; round <= 3; round++) {
    const order =
      (round % 2 === 1) === (first === 'before')
        ? ['before', 'after']
        : ['after', 'before'];
    for (const variant of order) {
      const beforeLoad = loadavg();
      const measurements = measure(variant, 'timing', b.name);
      for (const row of measurements) {
        const value = JSON.stringify(row.checked);
        if (expected.has(row.name) && expected.get(row.name) !== value) {
          throw new Error(`${row.name}: Fuel/allocation/output mismatch`);
        }
        expected.set(row.name, value);
      }
      records.push({
        round,
        variant,
        beforeLoad,
        afterLoad: loadavg(),
        measurements,
      });
    }
  }
}
const metadata = {
  filter,
  first,
  order: 'Per workload: 3 fresh process pairs, alternating AB/BA',
  started,
  finishedTiming: new Date().toISOString(),
  startingLoad,
  endingLoad: loadavg(),
  baseline: run('git', ['rev-parse', base]).trim(),
  head: run('git', ['rev-parse', 'HEAD']).trim(),
  diff: run('git', ['diff', base, '--', ...paths]),
  bun: Bun.version,
  platform: platform(),
  arch: arch(),
  cpu: cpus()[0]?.model,
  sourceSha256: Object.fromEntries(
    paths.map(path => [path, sha(readFileSync(resolve(root, path), 'utf8'))]),
  ),
  bundleSha256: Object.fromEntries(
    Object.entries(bundles).map(([key, path]) => [
      key,
      sha(readFileSync(path, 'utf8')),
    ]),
  ),
  warmupRuns: 5,
  samples: 5,
  minSampleMs: 50,
};
await Bun.write(
  resolve(out, 'timings.json'),
  JSON.stringify({ metadata, workloads, records }, null, 2),
);
// Heap observations stay outside timing. The same bundles support profile mode.
for (const variant of ['before', 'after']) {
  process.stderr.write(`Heap probe: ${variant}\n`);
  await Bun.write(
    resolve(out, `heap-${variant}.json`),
    JSON.stringify(
      workloads.flatMap(b => measure(variant, 'heap', b.name)),
      null,
      2,
    ),
  );
}
