// Paired timing and separate CPU/heap probes for #941. Copy this file unchanged
// into the baseline checkout, then run each mode in a fresh Bun process.
import { fullGC, heapStats, memoryUsage } from 'bun:jsc';
import { measure } from './measurement';
import { Loaded, manifest, sourceOf, type Benchmark } from './suite';

const mode = process.argv[2] ?? 'timing';
const filter = process.argv[3];
const names = new Set([
  'numbers/quantity',
  'numbers/divide',
  'core/loop',
  'macro/game-tick',
  'lifecycle/load-small',
]);
const benchmarks = manifest()
  .filter(b => names.has(b.name))
  .map(b => ({ ...b, source: sourceOf(b) }));
const quantity = benchmarks.find(b => b.name === 'numbers/quantity')!;
benchmarks.push(
  { ...quantity, name: 'quantity/sliced', slice: 17 },
  {
    name: 'quantity/ratio-compound',
    n: 200,
    expect: '3659400',
    smoke: { n: 1, expect: '18297' },
    source: `on run n
  put 0 into total
  repeat n times
    put (9 degF as degC) as degF into q
    put (2 m * 3 ft) as cm^2 into area
    add round(q / 1 degF, 0) + round(area / 1 cm^2, 0) to total
  end repeat
  return total
end run`,
  },
);

const stats = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    medianNs:
      sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2,
    minNs: sorted[0],
    maxNs: sorted.at(-1),
    samples: sorted.length,
  };
};
const output = [];
for (const b of benchmarks) {
  if (filter && b.name !== filter) {
    continue;
  }
  if (mode !== 'timing' && b.name !== 'numbers/quantity') {
    continue;
  }
  const loaded = new Loaded(b, b.name, b.source);
  const expected = loaded.run(b.n);
  if (expected.outcome !== 'completed' || expected.result !== b.expect) {
    throw new Error(`${b.name}: ${JSON.stringify(expected)}`);
  }
  const expectedJson = JSON.stringify(expected);
  const run = () => {
    const result = loaded.run(b.n);
    if (JSON.stringify(result) !== expectedJson) {
      throw new Error(`${b.name}: changed output or accounting`);
    }
  };
  for (let i = 0; i < 20; i++) {
    run();
  }
  if (mode === 'timing') {
    let loads = 0;
    // No heap callbacks or profiling in either timing region.
    const load = await measure(
      () => new Loaded(b as Benchmark, `load${++loads}`, b.source),
      {},
    );
    fullGC();
    for (let i = 0; i < 20; i++) {
      run();
    }
    const timing = await measure(run, {});
    output.push({
      name: b.name,
      ...expected,
      load: stats(load.samples),
      run: stats(timing.samples),
    });
  } else if (mode === 'profile') {
    const start = performance.now();
    let runs = 0;
    while (performance.now() - start < 3000) {
      run();
      runs++;
    }
    output.push({ name: b.name, ...expected, runs });
  } else if (mode === 'heap') {
    const samples = [];
    for (let i = 0; i < 30; i++) {
      fullGC();
      const before = heapStats().objectTypeCounts;
      const rss = memoryUsage().current;
      run();
      const after = heapStats().objectTypeCounts;
      samples.push({
        rssDelta: memoryUsage().current - rss,
        cells: Object.fromEntries(
          ['Object', 'Array', 'string', 'BigInt'].map(type => [
            type,
            (after[type] ?? 0) - (before[type] ?? 0),
          ]),
        ),
      });
    }
    fullGC();
    const before = heapStats();
    for (let i = 0; i < 100; i++) {
      run();
    }
    fullGC();
    const after = heapStats();
    output.push({
      name: b.name,
      ...expected,
      uncollectedCellsPerRun: samples,
      retainedBefore: before,
      retainedAfter: after,
    });
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }
}
process.stdout.write(`${JSON.stringify({ mode, bun: Bun.version, output })}\n`);
