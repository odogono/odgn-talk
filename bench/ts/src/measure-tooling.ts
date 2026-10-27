// Measures the tooling Benchmarks outside Bun, for a Node baseline:
// bun build bench/ts/src/measure-tooling.ts --target node --outdir bench/ts/dist,
// then node bench/ts/dist/measure-tooling.js [filter] [smoke]. It prints their measurements as JSON.
import { measureTooling } from './tooling';

const [filter, smokeFlag] = process.argv.slice(2);
const options =
  smokeFlag === 'smoke'
    ? { max_samples: 1, min_cpu_time: 0, min_samples: 1, warmup_samples: 0 }
    : {};
// eslint-disable-next-line no-console -- this entry prints its machine-readable result.
console.log(
  JSON.stringify(await measureTooling(filter || undefined, options, 'ts-node')),
);
