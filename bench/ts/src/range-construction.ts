// Paired #943 probe. Copy this identical file into both checkouts, then run
// `bun bench/ts/src/range-construction.ts timing|memory|profile [name]`.
// Timing excludes explicit GC/profiling. Every Run validates all accounting.
import { heapStats } from 'bun:jsc';
import { Loaded, manifest, sourceOf } from './suite';

const [mode = 'timing', filter = ''] = process.argv.slice(2);
if (!['timing', 'memory', 'profile'].includes(mode)) {
  throw new Error('Expected timing, memory or profile');
}
const names = new Set([
  'core/calls',
  'collections/list-update',
  'collections/list-build',
  'macro/transform',
  'numbers/add',
  'numbers/multiply',
  'numbers/divide',
  'numbers/quantity',
  'core/fib',
  'text/graphemes',
  'lifecycle/restore',
]);
const output = [];
for (const b of manifest().filter(
  b => names.has(b.name) && b.name.includes(filter),
)) {
  const source = sourceOf(b);
  const loaded = new Loaded(b, b.name, source);
  const expected = loaded.run(b.n);
  if (expected.outcome !== 'completed' || expected.result !== b.expect) {
    throw new Error(`${b.name}: invalid output`);
  }
  const validate = (report: typeof expected) => {
    if (JSON.stringify(report) !== JSON.stringify(expected)) {
      throw new Error(`${b.name}: output or accounting changed`);
    }
  };
  for (let i = 0; i < 20; i++) {
    validate(loaded.run(b.n));
  }
  if (mode === 'profile') {
    let runs = 0;
    const start = performance.now();
    while (performance.now() - start < 3000) {
      validate(loaded.run(b.n));
      runs++;
    }
    output.push({ benchmark: b.name, expected, runs });
  } else if (mode === 'memory') {
    // Keep only scalar counters: retaining JSC's full statistics objects
    // across collection would count the probe's own large bin tables.
    const heap = () => {
      const { heapSize, objectCount } = heapStats();
      return { heapSize, objectCount };
    };
    const samples = [];
    for (let i = 0; i < 20; i++) {
      Bun.gc(true);
      const before = heap();
      const report = loaded.run(b.n);
      const after = heap();
      const gcStart = performance.now();
      Bun.gc(true);
      const forcedGcMs = performance.now() - gcStart;
      const collected = heap();
      validate(report);
      samples.push({
        heapGrowth: after.heapSize - before.heapSize,
        objectGrowth: after.objectCount - before.objectCount,
        retainedHeap: collected.heapSize - before.heapSize,
        retainedObjects: collected.objectCount - before.objectCount,
        forcedGcMs,
      });
    }
    output.push({ benchmark: b.name, expected, samples });
  } else {
    // Separate fresh-name Load samples; compilation-cache hits are excluded.
    let loads = 0;
    const loadMs = [];
    for (let sample = -10; sample < 9; sample++) {
      const start = performance.now();
      new Loaded(b, `load${++loads}`, source);
      const elapsed = performance.now() - start;
      if (sample >= 0) {
        loadMs.push(elapsed);
      }
    }
    const runMs = [];
    for (let sample = 0; sample < 9; sample++) {
      let elapsed = 0;
      let runs = 0;
      while (elapsed < 50) {
        const start = performance.now();
        const report = loaded.run(b.n);
        elapsed += performance.now() - start;
        validate(report);
        runs++;
      }
      runMs.push(elapsed / runs);
    }
    output.push({ benchmark: b.name, expected, loadMs, runMs });
  }
}
process.stdout.write(
  JSON.stringify({ runtime: Bun.version, mode, output }) + '\n',
);
