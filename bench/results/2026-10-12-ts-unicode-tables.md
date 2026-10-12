# TS packed Unicode tables, 2026-10-12

Evidence for [#399](https://github.com/odogono/odgn-talk/issues/399), comparing
baseline commit `bba124d` with `a78257b`, which merged
[#662](https://github.com/odogono/odgn-talk/pull/662) and packs the TS Core's
Unicode tables into strings decoded at load. The
[raw measurements](2026-10-12-ts-unicode-tables.json) include all eighteen runner
outputs.

On an Apple M5 (10 cores, 24 GiB), darwin arm64, with Bun 1.4.2, language
1.0-rc.2 and Cost Model 0, three alternating baseline/packed pairs measured the
`text`, `macro` and `lifecycle/load` Benchmarks. Each cell is the median of the
three runs' medians. Every Benchmark kept its expected result, and Fuel was the
same before and after.

| Benchmark | Run before | Run after | Change | Load before | Load after | Change | Fuel |
|---|---|---|---|---|---|---|---|
| `lifecycle/load-large` | 433.58 µs | 398.21 µs | -8% | 13.62 ms | 13.36 ms | -2% | 4609 |
| `lifecycle/load-small` | 4.84 µs | 4.67 µs | -4% | 26.58 µs | 26.58 µs | 0% | 7 |
| `macro/game-tick` | 4.79 ms | 4.56 ms | -5% | 205.94 µs | 205.58 µs | -0% | 67042 |
| `macro/report` | 1.69 ms | 1.54 ms | -9% | 116.00 µs | 117.25 µs | 1% | 86555 |
| `macro/transform` | 1.55 ms | 1.49 ms | -4% | 167.21 µs | 166.17 µs | -1% | 20664 |
| `text/build` | 955.38 µs | 813.29 µs | -15% | 78.50 µs | 78.67 µs | 0% | 28928 |
| `text/graphemes` | 5.74 ms | 4.84 ms | -16% | 93.13 µs | 91.38 µs | -2% | 43518 |
| `text/index` | 8.00 ms | 4.91 ms | -39% | 114.71 µs | 113.92 µs | -1% | 26640 |
| `text/iterate` | 2.45 ms | 2.24 ms | -9% | 79.75 µs | 79.75 µs | 0% | 30318 |
| `text/patterns` | 5.50 ms | 5.28 ms | -4% | 97.46 µs | 103.21 µs | 6% | 13818 |

Every Run was as fast or faster. `text/index` gained most, because Character
indexing segments text and each grapheme lookup now binary-searches typed arrays
instead of nested array literals. Load times stayed within noise: the tables
decode once per process, not per Load, so this runner's Load measurement does
not include the decoding.

Each run started a fresh Bun process, and a baseline run was immediately
followed by a packed run, with no other test or benchmark jobs running. The
commands, run in a checkout of each commit, were:

```sh
bun bench/ts/src/measure-ts.ts text/
bun bench/ts/src/measure-ts.ts lifecycle/load
bun bench/ts/src/measure-ts.ts macro/
```

Timing is advisory. The browser bundle sizes the change was made for are in
#662: `src/index.ts` went from 227 KB to 164 KB gzip.
