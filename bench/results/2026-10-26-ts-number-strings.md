# TS number strings and digit counts

Measurements for [#1582](https://github.com/odogono/odgn-talk/issues/1582), based
on `915eae6e6c8faf8afd613628d0562baaa398b3cd` (`main` at intake). Numeric Run
medians improve by 12–18% on Bun. The `macro/game-tick` change is within the
suite's stated ±5–8% variation. The Node spot-check shows no repeatable
regression. The BigInt coefficient, exponent and sign representation is unchanged.

The [measurement data](2026-10-26-ts-number-strings.json) retain every process
median, all Node batch samples, output/accounting checks and before/after source
SHA-256 hashes.

## Method

Apple M5, 10 cores, 24 GiB, macOS arm64; Bun 1.4.4 and Node v26.12.1. Workloads
use their full manifest sizes, language 1.0-rc.3 and Cost Model 0.

Three before/after pairs ran sequentially, alternating baseline and candidate.
Each version ran these commands, without concurrent builds or tests:

```sh
bun run bench --only ts --count 5 --no-save --filter numbers/
bun run bench --only ts --count 5 --no-save --filter macro/game-tick
```

Only `values.ts`, `decimal.ts` and `units.ts` differ between the two measured
versions. Baseline copies came from the intake revision; candidate copies match
the source hashes in the data. The TS runner uses mitata's sample settings;
`--count 5` controls the suite's other runners. Each table entry below is the
median of the three process Run medians, rather than the fastest sample.

The Node spot-check bundles the same `Loaded`, `check`, `manifest` and `sourceOf`
helpers from `bench/ts/src/suite.ts` with `bun build --target=node`, defining
`import.meta.dir` as the absolute `bench/ts/src` directory. For each workload,
it checks the full-size result and accounting, warms up for 300 ms, then takes
seven batches lasting at least 100 ms each. A batch's time is divided by its
number of Runs. Two before/after pairs ran sequentially, with the median of
each process's seven batches retained. Node table entries are the median of
the two process medians. These are advisory spot-checks on one machine.

## Run times

| Workload | Bun before ms | Bun after ms | Change | Node before ms | Node after ms | Change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `numbers/add` | 0.890 | 0.779 | −12.5% | 1.3878 | 1.2145 | −12.5% |
| `numbers/multiply` | 0.728 | 0.599 | −17.7% | 1.0934 | 1.0748 | −1.7% |
| `numbers/divide` | 0.939 | 0.792 | −15.7% | 1.3779 | 1.3462 | −2.3% |
| `numbers/quantity` | 0.895 | 0.777 | −13.2% | 1.3187 | 1.2524 | −5.0% |
| `macro/game-tick` | 2.232 | 2.116 | −5.2% | 3.8413 | 3.8901 | +1.3% |

For `numbers/quantity`, Bun's three candidate medians span 0.768–0.845 ms,
against 0.884–0.896 ms before. For `macro/game-tick`, before/after ranges
overlap: 2.119–2.242 ms and 2.091–2.266 ms. Small macro and Node changes should
be read in light of that process variation.

## Implementation and parity

Arithmetic results retain frozen decimal parts and build their canonical text
only when requested, caching the result. Constructors that already have
canonical text retain it. Digit counts use a JS numeric estimate corrected by
exact comparisons against BigInt powers of ten. Intermediates beyond the JS
number range use an exact power-of-ten search.

Unit conversion retains factor order and rounding at each nonidentity step.
Multiplication or division by exactly one is skipped only when the input
already fits the decimal limits and has a normalized zero sign. Unchecked
cohorts retain the arithmetic step, since even an identity factor can round
them. Factor ratios are never collapsed or reordered.

All measured outputs, Fuel and logical allocation agree before and after:

| Workload | Output | Fuel | Logical allocation bytes |
| --- | ---: | ---: | ---: |
| `numbers/add` | 2000 | 26,030 | 32,104 |
| `numbers/multiply` | 5005000 | 18,031 | 32,104 |
| `numbers/divide` | 500500 | 18,031 | 32,104 |
| `numbers/quantity` | 125250 | 14,579 | 40,088 |
| `macro/game-tick` | 3000 | 67,042 | 80,270 |

Validation: 6,599 TS tests pass, with 75 reactor-dependent tests skipped;
all 468 corpus cases pass against their existing expectations. An additional
8,500 deterministic arithmetic result/fault comparisons against the baseline
agree, including extreme exponents. Regression tests cover deferred/cached
formatting, immutable snapshots, powers-of-ten boundaries through 100,000
digits, and identity conversions of unchecked cohorts. Typecheck, lint,
formatting, repository checks and the TS build pass. No corpus expectations,
Cost Model data or save format changed.
