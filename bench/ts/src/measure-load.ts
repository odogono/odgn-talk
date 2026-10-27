// Load-only timing and profiling, shared by Bun and Node. See bench/README.md.
import { performance } from 'node:perf_hooks';
import { measure } from './measurement';
import { statsOf } from './report';
import { check, Loaded, manifest, selected, sourceOf } from './suite';

const [filter = 'lifecycle/load', mode = 'timing'] = process.argv.slice(2);
if (mode !== 'timing' && mode !== 'profile') {
  throw new Error('Mode must be timing or profile');
}
const benchmarks = manifest().filter(b => selected(b, filter) && !b.skip?.ts);
if (!benchmarks.length || (mode === 'profile' && benchmarks.length !== 1)) {
  throw new Error(
    'Select at least one Benchmark, or exactly one for profiling',
  );
}
const measurements = [];
for (const benchmark of benchmarks) {
  // Verify output and Fuel before timing; no Run is included in the samples.
  const checked = check(benchmark, false);
  const source = sourceOf(benchmark);
  let loads = 0;
  const load = () => new Loaded(benchmark, `load${++loads}`, source);
  if (mode === 'profile') {
    const end = performance.now() + 5000;
    while (performance.now() < end) {
      load();
    }
    measurements.push({ benchmark: benchmark.name, checked, loads });
  } else {
    const result = await measure(load, {});
    measurements.push({
      benchmark: benchmark.name,
      checked,
      load: statsOf(result.samples),
    });
  }
}
// eslint-disable-next-line no-console -- this entry prints its machine-readable result.
console.log(JSON.stringify(measurements));
