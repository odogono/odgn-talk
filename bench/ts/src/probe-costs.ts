// Run through compare-costs.ts so before/after execute isolated bundled Cores.
import { heapStats, memoryUsage } from 'bun:jsc';
import { check, Loaded, manifest, sourceOf } from './suite';

export const probeNames = [
  'core/loop',
  'core/calls',
  'core/lambdas',
  'core/fib',
  'core/fib@slice=10',
  'core/fib@slice=100',
  'core/fib@slice=1000',
  'core/fib@slice=10000',
  'numbers/add',
  'numbers/multiply',
  'numbers/divide',
  'numbers/quantity',
  'collections/list-build',
  'collections/list-append',
  'collections/list-update',
  'collections/map-update',
  'text/build',
  'text/index',
  'text/patterns',
  'macro/transform',
  'host/immediate',
  'lifecycle/rollback',
];
export const makeTimingProbe = (name: string) => {
  const b = manifest().find(b => b.name === name);
  if (!b) {
    throw new Error(`Unknown benchmark ${name}`);
  }
  const expected = check(b, false);
  const loaded = new Loaded(b, b.name, sourceOf(b));
  return {
    benchmark: b.name,
    n: b.n,
    slice: b.slice,
    expected,
    run: () => loaded.run(b.n),
  };
};

if (import.meta.main) {
  const [mode = 'timing', filter = ''] = process.argv.slice(2);
  const results = [];
  for (const name of probeNames.filter(name => !filter || name === filter)) {
    const probe = makeTimingProbe(name);
    const { expected } = probe;
    const validate = (actual: ReturnType<Loaded['run']>) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${name}: accounting/output changed`);
      }
    };
    for (let i = 0; i < 20; i++) {
      validate(probe.run());
    }
    if (mode === 'profile') {
      const until = performance.now() + 3000;
      let runs = 0;
      do {
        validate(probe.run());
        runs++;
      } while (performance.now() < until);
      results.push({ benchmark: name, expected, runs });
    } else if (mode === 'heap') {
      Bun.gc(true);
      const before = {
        heap: heapStats(),
        memory: memoryUsage(),
        process: process.memoryUsage(),
      };
      for (let i = 0; i < 100; i++) {
        validate(probe.run());
      }
      const after = {
        heap: heapStats(),
        memory: memoryUsage(),
        process: process.memoryUsage(),
      };
      const start = performance.now();
      Bun.gc(true);
      const gcMs = performance.now() - start;
      const retained = {
        heap: heapStats(),
        memory: memoryUsage(),
        process: process.memoryUsage(),
      };
      results.push({
        benchmark: name,
        expected,
        runs: 100,
        before,
        after,
        retained,
        gcMs,
      });
    } else {
      const samplesNs = [];
      for (let sample = 0; sample < 7; sample++) {
        const start = performance.now();
        let actual: ReturnType<Loaded['run']> | undefined;
        for (let i = 0; i < 20; i++) {
          actual = probe.run();
        }
        samplesNs.push(((performance.now() - start) * 1e6) / 20);
        validate(actual!);
      }
      results.push({
        benchmark: name,
        n: probe.n,
        slice: probe.slice,
        expected,
        samplesNs,
      });
    }
  }
  process.stdout.write(JSON.stringify(results));
}
