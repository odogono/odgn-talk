// Measures the selected Benchmarks on the TS Core with mitata and prints
// their measurements as JSON. `main.ts` runs it in its own process.
import { memoryUsage } from 'bun:jsc';
import { measure } from './measurement';
import { type Measurement, statsOf } from './report';
import { check, Loaded, manifest, selected, sizeOf, sourceOf } from './suite';

const [filter, smokeFlag] = process.argv.slice(2);
const smoke = smokeFlag === 'smoke';
const heap = () => memoryUsage().current;
const options = smoke
  ? { heap, max_samples: 1, min_cpu_time: 0, min_samples: 1, warmup_samples: 0 }
  : { heap };

const measurements: Measurement[] = [];
for (const b of manifest().filter(
  b => selected(b, filter || undefined) && !b.skip?.ts,
)) {
  const checked = check(b, smoke);
  const source = sourceOf(b);
  let loads = 0;
  // A fresh name for each Load, so the compile cache never hits.
  const load = await measure(
    () => new Loaded(`load${++loads}`, source, b.host),
    options,
  );
  const loaded = new Loaded(b.name, source, b.host);
  const { n } = sizeOf(b, smoke);
  const run = await measure(() => loaded.run(n), options);
  measurements.push({
    benchmark: b.name,
    fuel: checked.fuel,
    ...(run.heap ? { hostBytes: Math.max(0, run.heap.avg) } : {}),
    load: statsOf(load.samples),
    logicalAlloc: checked.alloc,
    run: statsOf(run.samples),
    runner: 'ts',
  });
}
console.log(JSON.stringify(measurements));
