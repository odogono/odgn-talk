// Alternating accounting comparison. Each bundle contains the same current
// sources except costs.ts, loaded from the supplied before revision for A.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { arch, cpus, loadavg, platform } from 'node:os';

const [base = 'HEAD', destination = '.cache/cost-comparison', filter = ''] =
  process.argv.slice(2);
const root = resolve(import.meta.dir, '../../..');
const out = resolve(destination);
const started = new Date().toISOString();
const startingLoad = loadavg();
mkdirSync(out, { recursive: true });
const git = (...args: string[]) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout;
};
const baseline = git('show', `${base}:impl/ts/src/costs.ts`);
const bundles: Record<string, string> = {};
for (const variant of ['before', 'after']) {
  const path = resolve(out, `${variant}.js`);
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, 'probe-costs.ts')],
    target: 'bun',
    sourcemap: 'inline',
    plugins: [
      {
        name: 'accounting-baseline',
        setup(build) {
          build.onLoad({ filter: /\/suite\.ts$/ }, args => ({
            contents: readFileSync(args.path, 'utf8').replaceAll(
              'import.meta.dir',
              JSON.stringify(import.meta.dir),
            ),
            loader: 'ts',
          }));
          if (variant === 'before') {
            build.onLoad({ filter: /\/impl\/ts\/src\/costs\.ts$/ }, () => ({
              contents: baseline,
              loader: 'ts',
            }));
          }
        },
      },
    ],
  });
  if (!result.success) {
    throw new Error(result.logs.join('\n'));
  }
  await Bun.write(path, result.outputs[0]!);
  bundles[variant] = path;
}
const records = [];
const run = (variant: string, mode: string) => {
  const result = spawnSync(
    process.execPath,
    [bundles[variant]!, mode, filter],
    {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return JSON.parse(result.stdout) as {
    benchmark: string;
    expected: unknown;
  }[];
};
const before: typeof import('./probe-costs') = await import(bundles.before!);
const after: typeof import('./probe-costs') = await import(bundles.after!);
for (let round = 1; round <= 3; round++) {
  for (const variant of ['before', 'after']) {
    records.push({
      round,
      variant,
      measurements: [] as {
        benchmark: string;
        expected: unknown;
        n: number;
        samplesNs: number[];
        slice: number | undefined;
      }[],
    });
  }
}
for (const name of before.probeNames.filter(
  name => !filter || name === filter,
)) {
  process.stderr.write(`Paired batches: ${name}\n`);
  const a = before.makeTimingProbe(name);
  const b = after.makeTimingProbe(name);
  if (JSON.stringify(a.expected) !== JSON.stringify(b.expected)) {
    throw new Error(`${name}: accounting/output mismatch`);
  }
  for (let i = 0; i < 20; i++) {
    a.run();
    b.run();
  }
  for (let round = 1; round <= 3; round++) {
    const samples: Record<string, number[]> = { before: [], after: [] };
    for (let batch = 0; batch < 7; batch++) {
      const pair =
        (round + batch) % 2
          ? ([
              ['before', a],
              ['after', b],
            ] as const)
          : ([
              ['after', b],
              ['before', a],
            ] as const);
      for (const [variant, probe] of pair) {
        const start = performance.now();
        let actual;
        for (let i = 0; i < 20; i++) {
          actual = probe.run();
        }
        samples[variant]!.push(((performance.now() - start) * 1e6) / 20);
        if (JSON.stringify(actual) !== JSON.stringify(probe.expected)) {
          throw new Error(`${name}: measured Run changed`);
        }
      }
    }
    for (const record of records.filter(r => r.round === round)) {
      record.measurements.push({
        benchmark: name,
        n: a.n,
        slice: a.slice,
        expected: a.expected,
        samplesNs: samples[record.variant]!,
      });
    }
  }
}
const expected = new Map<string, string>();
for (const record of records) {
  for (const row of record.measurements) {
    const value = JSON.stringify(row.expected);
    if (expected.has(row.benchmark) && expected.get(row.benchmark) !== value) {
      throw new Error(`${row.benchmark}: before/after mismatch`);
    }
    expected.set(row.benchmark, value);
  }
}
const metadata = {
  filter,
  order: 'Per workload: 3 rounds of 7 paired 20-Run batches, alternating AB/BA',
  started,
  finishedTiming: new Date().toISOString(),
  startingLoad,
  endingLoad: loadavg(),
  baseline: git('rev-parse', base).trim(),
  head: git('rev-parse', 'HEAD').trim(),
  diff: git(
    'diff',
    '--',
    'impl/ts/src/costs.ts',
    'tools/costs/emit-ts.ts',
    'tools/syntax/generate.ts',
  ),
  bun: Bun.version,
  platform: platform(),
  arch: arch(),
  cpu: cpus()[0]?.model,
  sourceSha256: Object.fromEntries(
    await Promise.all(
      [
        'impl/ts/src/costs.ts',
        'impl/ts/src/generated/costs.ts',
        'tools/costs/emit-ts.ts',
      ].map(async path => [
        path,
        new Bun.CryptoHasher('sha256')
          .update(await Bun.file(resolve(root, path)).arrayBuffer())
          .digest('hex'),
      ]),
    ),
  ),
  warmupRuns: 20,
  batches: 7,
  runsPerBatch: 20,
  bundleSha256: Object.fromEntries(
    await Promise.all(
      Object.entries(bundles).map(async ([key, path]) => [
        key,
        new Bun.CryptoHasher('sha256')
          .update(await Bun.file(path).arrayBuffer())
          .digest('hex'),
      ]),
    ),
  ),
};
await Bun.write(
  resolve(out, 'timings.json'),
  JSON.stringify({ metadata, records }, null, 2),
);
// Heap observations and forced full-GC duration are collected separately.
for (const variant of ['before', 'after']) {
  process.stderr.write(`Heap probe: ${variant}\n`);
  await Bun.write(
    resolve(out, `heap-${variant}.json`),
    JSON.stringify(run(variant, 'heap'), null, 2),
  );
}
