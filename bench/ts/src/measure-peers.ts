// Measures the selected Benchmarks' ports in each Peer Language on Bun with
// mitata and prints their measurements as JSON. `main.ts` runs it in its own
// process.
import { memoryUsage } from 'bun:jsc';
import { measure } from './measurement';
import { loadPeer, peers } from './peers';
import { type Measurement, statsOf } from './report';
import { manifest, selected, sizeOf } from './suite';

const [filter, smokeFlag] = process.argv.slice(2);
const smoke = smokeFlag === 'smoke';
const heap = () => memoryUsage().current;
const options = smoke
  ? { heap, max_samples: 1, min_cpu_time: 0, min_samples: 1, warmup_samples: 0 }
  : { heap };

const measurements: Measurement[] = [];
for (const peer of peers) {
  for (const b of manifest().filter(
    b => selected(b, filter || undefined) && !b.skip?.peers,
  )) {
    const port = await loadPeer(peer, b, smoke);
    const { n } = sizeOf(b, smoke);
    const run = await measure(() => port(n), options);
    measurements.push({
      benchmark: b.name,
      // The WebAssembly peers allocate inside their own memory, which Bun's
      // heap doesn't see.
      ...(peer.name === 'ts-native' && run.heap
        ? { hostBytes: Math.max(0, run.heap.avg) }
        : {}),
      run: statsOf(run.samples),
      runner: peer.name,
    });
  }
}
console.log(JSON.stringify(measurements));
