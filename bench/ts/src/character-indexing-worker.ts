// Paired TS chunk-read measurements. The driver bundles this once per revision;
// timings, CPU profiles and heap probes run in separate processes.
import { readFileSync } from 'node:fs';
import { heapStats, memoryUsage } from 'bun:jsc';
import { Loaded, type Benchmark } from './suite';

type Workload = Pick<Benchmark, 'name' | 'n' | 'expect' | 'host' | 'slice'> & {
  source: string;
};
const [input, mode = 'timing', filter = ''] = process.argv.slice(2);
const workloads = JSON.parse(readFileSync(input!, 'utf8')) as Workload[];
const results = [];
for (const b of workloads.filter(b => b.name.includes(filter))) {
  const loaded = new Loaded(b, b.name, b.source);
  const checked = loaded.run(b.n);
  if (checked.outcome !== 'completed' || checked.result !== b.expect) {
    throw new Error(`${b.name}: ${JSON.stringify(checked)}`);
  }
  const run = () => {
    const report = loaded.run(b.n);
    if (JSON.stringify(report) !== JSON.stringify(checked)) {
      throw new Error(`${b.name}: accounting/output changed`);
    }
  };
  if (mode === 'validate') {
    results.push({ name: b.name, checked });
    continue;
  }
  const warmups = mode === 'profile' ? 20 : 5;
  for (let i = 0; i < warmups; i++) {
    run();
  }
  if (mode === 'profile') {
    const until = performance.now() + 3000;
    let runs = 0;
    while (performance.now() < until) {
      run();
      runs++;
    }
    results.push({ name: b.name, runs, checked });
  } else if (mode === 'heap') {
    Bun.gc(true);
    const before = { memory: memoryUsage(), heap: heapStats() };
    for (let i = 0; i < 20; i++) {
      run();
    }
    const uncollected = { memory: memoryUsage(), heap: heapStats() };
    const start = performance.now();
    Bun.gc(true);
    const gcMs = performance.now() - start;
    results.push({
      name: b.name,
      checked,
      before,
      uncollected,
      collected: { memory: memoryUsage(), heap: heapStats() },
      gcMs,
    });
  } else {
    const samples = [];
    for (let sample = 0; sample < 5; sample++) {
      const start = performance.now();
      let runs = 0;
      do {
        run();
        runs++;
      } while (performance.now() - start < 50);
      samples.push({ runs, ns: ((performance.now() - start) * 1e6) / runs });
    }
    const load = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      new Loaded(b, `${b.name}-load-${i}`, b.source);
      load.push((performance.now() - start) * 1e6);
    }
    results.push({ name: b.name, checked, run: samples, load });
    console.error(`${b.name}: timed`);
  }
}
console.log(JSON.stringify(results));
