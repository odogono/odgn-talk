// Isolate Group overhead with the same Scripts and current Core in both
// bundles, substituting only group.ts from the named baseline revision.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { arch, cpus, loadavg, platform } from 'node:os';
import { resolve } from 'node:path';
import { manifest, sourceOf, type RunReport } from './suite';

const [
  base = 'HEAD',
  destination = '.cache/ts-messaging-lifecycle',
  filter = '',
  first = 'before',
] = process.argv.slice(2);
if (first !== 'before' && first !== 'after') {
  throw new Error('First variant must be before or after');
}
const variants: ('before' | 'after')[] =
  first === 'before' ? ['before', 'after'] : ['after', 'before'];
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
const groupPath = 'impl/ts/src/group.ts';
const before = run('git', ['show', `${base}:${groupPath}`]);
const after = readFileSync(resolve(root, groupPath), 'utf8');
const sha = (source: string) =>
  new Bun.CryptoHasher('sha256').update(source).digest('hex');
const bundles: Record<string, string> = {};
for (const [variant, source] of [
  ['before', before],
  ['after', after],
]) {
  for (const [suffix, entrypoint] of [
    ['', 'character-indexing-worker.ts'],
    ['-probe', 'probe-costs.ts'],
  ]) {
    const result = await Bun.build({
      entrypoints: [resolve(import.meta.dir, entrypoint!)],
      target: 'bun',
      sourcemap: 'inline',
      plugins: [
        {
          name: 'messaging-lifecycle-comparison',
          setup(build) {
            build.onLoad({ filter: /\/suite\.ts$/ }, args => ({
              contents: readFileSync(args.path, 'utf8').replaceAll(
                'import.meta.dir',
                JSON.stringify(import.meta.dir),
              ),
              loader: 'ts',
            }));
            build.onLoad({ filter: /\/impl\/ts\/src\/group\.ts$/ }, () => ({
              contents: source!,
              loader: 'ts',
            }));
          },
        },
      ],
    });
    if (!result.success) {
      throw new Error(result.logs.join('\n'));
    }
    const key = `${variant}${suffix}`;
    const path = resolve(out, `${key}.js`);
    await Bun.write(path, result.outputs[0]!);
    bundles[key] = path;
  }
}
const workloads = manifest()
  .filter(
    b =>
      b.name.startsWith('messaging/') ||
      b.name.startsWith('lifecycle/') ||
      ['core/loop', 'host/immediate', 'host/pump'].includes(b.name),
  )
  .filter(b => b.name.includes(filter))
  .map(b => ({ ...b, source: sourceOf(b) }));
if (!workloads.length) {
  throw new Error('Filter selects no workloads');
}
const input = resolve(out, 'workloads.json');
await Bun.write(input, JSON.stringify(workloads, null, 2));
const startingLoad = loadavg();
const started = new Date().toISOString();
const modules = new Map<'before' | 'after', typeof import('./probe-costs')>();
for (const variant of variants) {
  modules.set(variant, await import(bundles[`${variant}-probe`]!));
}
const records = [];
const runsPerBatch = 10;
for (const workload of workloads) {
  process.stderr.write(`Paired batches: ${workload.name}\n`);
  const one = modules.get(variants[0]!)!.makeTimingProbe(workload.name);
  const two = modules.get(variants[1]!)!.makeTimingProbe(workload.name);
  const probes =
    first === 'before'
      ? { before: one, after: two }
      : { before: two, after: one };
  const expected = JSON.stringify(probes.before.expected);
  if (expected !== JSON.stringify(probes.after.expected)) {
    throw new Error(`${workload.name}: baseline accounting/output mismatch`);
  }
  const checked = (actual: RunReport) => {
    if (JSON.stringify(actual) !== expected) {
      throw new Error(`${workload.name}: accounting/output changed`);
    }
  };
  for (let i = 0; i < 20; i++) {
    for (const variant of variants) {
      checked(probes[variant].run());
    }
  }
  for (let round = 1; round <= 3; round++) {
    const samplesNs = { before: [] as number[], after: [] as number[] };
    for (let batch = 0; batch < 7; batch++) {
      const order: ('before' | 'after')[] =
        (round + batch) % 2 ? ['before', 'after'] : ['after', 'before'];
      for (const variant of order) {
        const start = performance.now();
        for (let i = 0; i < runsPerBatch; i++) {
          checked(probes[variant].run());
        }
        samplesNs[variant].push(
          ((performance.now() - start) * 1e6) / runsPerBatch,
        );
      }
    }
    records.push({
      benchmark: workload.name,
      n: workload.n,
      round,
      expected: probes.before.expected,
      samplesNs,
    });
  }
}
const metadata = {
  baselineRevision: run('git', ['rev-parse', base]).trim(),
  checkoutRevision: run('git', ['rev-parse', 'HEAD']).trim(),
  substitutedSource: groupPath,
  sourceSha256: { before: sha(before), after: sha(after) },
  bundleSha256: Object.fromEntries(
    Object.entries(bundles).map(([key, path]) => [
      key,
      sha(readFileSync(path, 'utf8')),
    ]),
  ),
  diff: run('git', ['diff', base, '--', groupPath]),
  bun: Bun.version,
  platform: platform(),
  arch: arch(),
  cpu: cpus()[0]?.model,
  started,
  finishedTiming: new Date().toISOString(),
  startingLoad,
  endingLoad: loadavg(),
  settings: { warmupRuns: 20, rounds: 3, batches: 7, runsPerBatch },
  first,
  order:
    'Per workload: same-process isolated bundles, alternating AB/BA batches',
};
await Bun.write(
  resolve(out, 'timings.json'),
  JSON.stringify({ metadata, workloads, records }, null, 2) + '\n',
);
// CPU captures and heap observations use separate processes, outside timing.
for (const variant of ['before', 'after']) {
  const heap = run(process.execPath, [bundles[variant]!, input, 'heap']);
  await Bun.write(resolve(out, `heap-${variant}.json`), heap);
}
