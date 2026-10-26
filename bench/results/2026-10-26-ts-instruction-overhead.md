# TS instruction overhead (#1580)

Measured on 2026-10-26, Apple M5 (10 cores, 24 GiB), macOS arm64. Bun 1.4.4 and Node v26.12.1. Baseline: `origin/main` at `915eae6e6c8faf8afd613628d0562baaa398b3cd`; candidate: this change on `chore/issue-1580`. The [raw measurements](2026-10-26-ts-instruction-overhead.json) retain all reports, exact repeated-run statistics, Node batch samples and bundle hashes.

The first pair used the ordinary suite on unchanged main and then the candidate:

```sh
bun run bench --only ts --count 5 --no-save --filter core/
bun run bench --only ts --count 5 --no-save --filter macro/
bun run bench --only ts --count 5 --no-save --filter collections/
```

Two further pairs ran frozen bundles of `bench/ts/src/measure-ts.ts`, built from the complete baseline and candidate TS Core sources. Bundling replaced the suite module's `import.meta.dir` with its original absolute directory so both read the same manifest and Scripts. The runner and its mitata defaults were unchanged. Each round ran baseline core/macros/collections followed by candidate core/macros/collections, sequentially, without concurrent tests, builds or profiling. The first pair's report rounds Run medians to 1 µs; the later pairs retain full JSON precision. `--count 5` is recorded by the CLI; mitata chooses the Bun sample counts automatically.

All 17 workloads are included, including every Fibonacci Fuel Slice. Times below are Run medians in µs, in round order. Change is the median of the three paired percentage changes (negative is faster). Differences within roughly 5–8% should be treated as normal variation.

| Benchmark | Main (µs), rounds 1 / 2 / 3 | Candidate (µs), rounds 1 / 2 / 3 | Paired change |
| - | -: | -: | -: |
| collections/iterate | 1533.0 / 1686.9 / 1543.6 | 1354.0 / 1320.8 / 1336.8 | -13.4% |
| collections/list-append | 1863.0 / 2037.7 / 2100.8 | 1606.0 / 1627.4 / 1735.0 | -17.4% |
| collections/list-build | 340.0 / 418.6 / 394.5 | 339.0 / 364.3 / 356.5 | -9.6% |
| collections/list-update | 835.0 / 930.4 / 888.1 | 870.0 / 791.7 / 817.9 | -7.9% |
| collections/map-build | 534.0 / 554.7 / 592.1 | 450.0 / 463.0 / 431.4 | -16.5% |
| collections/map-update | 446.0 / 443.8 / 476.4 | 350.0 / 311.2 / 320.9 | -29.9% |
| core/calls | 948.0 / 1121.8 / 1136.3 | 824.0 / 881.9 / 941.9 | -17.1% |
| core/fib | 631.0 / 687.0 / 749.5 | 622.0 / 654.8 / 657.7 | -4.7% |
| core/fib@slice=10 | 3566.0 / 4477.0 / 4533.0 | 3765.0 / 3970.2 / 3907.5 | -11.3% |
| core/fib@slice=100 | 981.0 / 1168.9 / 1147.9 | 903.0 / 987.1 / 970.6 | -15.4% |
| core/fib@slice=1000 | 700.0 / 820.0 / 801.0 | 630.0 / 722.1 / 744.5 | -10.0% |
| core/fib@slice=10000 | 662.0 / 771.6 / 783.1 | 602.0 / 643.0 / 697.4 | -10.9% |
| core/lambdas | 1186.0 / 1347.5 / 1334.4 | 1040.0 / 1084.1 / 1110.9 | -16.7% |
| core/loop | 372.0 / 380.5 / 406.5 | 362.0 / 383.4 / 376.5 | -2.7% |
| macro/game-tick | 2023.0 / 2517.4 / 2301.1 | 1532.0 / 1771.1 / 1630.0 | -29.2% |
| macro/report | 1147.0 / 1414.3 / 1374.8 | 1123.0 / 1257.4 / 1256.1 | -8.6% |
| macro/transform | 886.0 / 1122.5 / 1037.5 | 570.0 / 688.3 / 735.6 | -35.7% |

`macro/transform`, `macro/game-tick`, calls, Lambdas and Map writes show the clearest repeatable improvements. The `core/loop` change is within noise; unsliced Fibonacci is also too close to call confidently. The first `slice=10` and List-update pair was slightly slower; both improved in the repeats. Absolute times drifted between rounds, which is why paired changes and every round are retained.

## Node Fibonacci

The same unmodified suite `Loaded`/`check` harness was bundled with `--target=node` against each complete Core. Each process validated output, Fuel and logical allocation on every Run, warmed up 50 Runs, then measured nine batches of 200 Runs. The figures are medians of batch means in µs.

| Round | Main | Candidate | Change |
| - | -: | -: | -: |
| 1 | 1127.2 | 1362.7 | +20.9% |
| 2 | 1176.3 | 1048.2 | -10.9% |
| 3 | 1191.0 | 1036.6 | -13.0% |

The first candidate process was noisy (batch means 1,093–1,505 µs). It is retained rather than discarded. The two subsequent pairs improved by about 11–13%; the median paired change is about −11%. This is a runtime spot-check, not a CI performance gate. Every sample returned `610`, Fuel `46365` and logical allocation `47328`.

To reproduce the Node probe, create `.cache/instruction-node.ts` with:

```ts
import { check, Loaded, manifest, sourceOf } from '../bench/ts/src/suite';
const b = manifest().find(b => b.name === 'core/fib')!;
const expected = check(b, false);
const loaded = new Loaded(b, b.name, sourceOf(b));
const run = () => {
  if (JSON.stringify(loaded.run(b.n)) !== JSON.stringify(expected)) {
    throw new Error('Output/accounting changed');
  }
};
for (let i = 0; i < 50; i++) run();
const samplesNs: number[] = [];
for (let sample = 0; sample < 9; sample++) {
  const start = performance.now();
  for (let i = 0; i < 200; i++) run();
  samplesNs.push((performance.now() - start) * 1e6 / 200);
}
console.log(JSON.stringify({ expected, samplesNs }));
```

Build it from the repository root with the following `.cache/build-instruction-node.ts`, then run `bun .cache/build-instruction-node.ts` and `node .cache/instruction-node.mjs` alternately against main and the candidate. Keep the probe and build script identical between revisions. A plain CLI bundle without the substitution would look for `bench/scripts` relative to the output file.

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const directory = resolve('bench/ts/src');
const result = await Bun.build({
  entrypoints: ['.cache/instruction-node.ts'],
  target: 'node',
  plugins: [{
    name: 'suite-directory',
    setup(build) {
      build.onLoad({ filter: /\/suite\.ts$/ }, args => ({
        contents: readFileSync(args.path, 'utf8').replaceAll(
          'import.meta.dir', JSON.stringify(directory),
        ),
        loader: 'ts',
      }));
    },
  }],
});
if (!result.success) throw new Error(result.logs.join('\n'));
await Bun.write('.cache/instruction-node.mjs', result.outputs[0]!);
```

## Correctness

The repeated Bun measurements retain identical Fuel and logical allocation before/after; the suite validates each workload's output before timing. Node additionally validates output and accounting in every timed Run. CPU time and Host heap observations are advisory; no total JS allocation count is claimed. Full Corpus and fast/general-step Trace comparisons are the semantic gates, with Host mutation regressions covering kind/method replacement and detached Map pairs, including persistent sibling versions.

Validation on the candidate:

- `bun test impl/ts/tests impl/ts/examples`: 6,672 passed, zero failed, including fast/general-step comparisons and the native/WASM embedding parity suites.
- `bun run corpus:run`: 468 supported cases passed with no failures.
- `bun impl/ts/tools/wasm-corpus.ts --quiet`: 422 passed, zero failures or known divergences; one case exceeded the adapter's frame-size limit.
- `bun run syntax:check`, `bun test tools/costs`, `bun run typecheck`, `bun run lint`, `bun run format:check` and `bun run --cwd impl/ts build` passed. The WASM reactor was rebuilt from this checkout before the parity runs.
