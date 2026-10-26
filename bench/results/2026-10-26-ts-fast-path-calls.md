# TS fast path for iteration, keys, appends and calls (#1585)

Measured on 2026-10-26, Apple M5 (10 cores, 24 GiB), macOS arm64. Bun 1.4.4 and Node v26.12.1. Baseline: `origin/main` at `3bf77a7943523e28ef1f315d3f202874744a5a4e`; candidate: this change.

Each round ran, on main and then on the candidate:

```sh
bun run bench --only ts --count 5 --no-save --filter core/
bun run bench --only ts --count 5 --no-save --filter collections/
bun run bench --only ts --count 5 --no-save --filter macro/
```

Times are Run medians in µs, in round order. Change is the median of the three paired changes (negative is faster). Runs vary by ±5–8%.

| Benchmark | Main (µs), rounds 1 / 2 / 3 | Candidate (µs), rounds 1 / 2 / 3 | Paired change |
| - | -: | -: | -: |
| collections/iterate | 1407 / 1187 / 1362 | 877 / 1069 / 938 | -31.1% |
| collections/list-append | 1917 / 1336 / 1772 | 1051 / 1465 / 1063 | -40.0% |
| collections/list-build | 373 / 272 / 380 | 242 / 279 / 237 | -35.1% |
| collections/list-update | 915 / 683 / 797 | 611 / 901 / 618 | -22.5% |
| collections/map-build | 531 / 383 / 481 | 352 / 521 / 381 | -20.8% |
| collections/map-update | 394 / 300 / 356 | 273 / 334 / 279 | -21.6% |
| core/calls | 1045 / 785 / 966 | 540 / 579 / 532 | -44.9% |
| core/fib | 708 / 587 / 743 | 443 / 573 / 404 | -37.4% |
| core/fib@slice=10 | 7231 / 3582 / 5994 | 4655 / 5179 / 3568 | -35.6% |
| core/fib@slice=100 | 1476 / 912 / 1161 | 773 / 856 / 735 | -36.7% |
| core/fib@slice=1000 | 771 / 644 / 772 | 457 / 473 / 436 | -40.7% |
| core/fib@slice=10000 | 722 / 602 / 735 | 425 / 449 / 407 | -41.1% |
| core/lambdas | 1246 / 995 / 1202 | 848 / 923 / 838 | -30.3% |
| core/loop | 404 / 356 / 426 | 406 / 417 / 396 | +0.5% |
| macro/game-tick | 1905 / 2010 / 1712 | 1099 / 1513 / 1208 | -29.4% |
| macro/report | 801 / 722 / 696 | 572 / 728 / 646 | -7.2% |
| macro/transform | 693 / 572 / 615 | 413 / 664 / 449 | -27.0% |

`core/loop` already ran entirely on the fast path, so it is unchanged. `macro/report` spends its time in text concatenation, which still takes the general step.

## Node spot-check

A small harness, bundled with `bun build --target node` against each tree's `impl/ts/src/index.ts`, loads the Script into a fresh Group per Run and pumps it to idle. It warms up with 50 Runs, then takes the median of nine batch means, in µs.

| Benchmark (n, Runs per batch) | Main, rounds 1 / 2 / 3 | Candidate, rounds 1 / 2 / 3 | Paired change |
| - | -: | -: | -: |
| core/fib (15, 100) | 1078.2 / 1088.8 / 1083.4 | 750.1 / 753.3 / 784.2 | -30.8% |
| collections/iterate (200, 20) | 3391.7 / 3372.7 / 3413.9 | 2177.4 / 2160.3 / 2144.8 | -35.9% |
| macro/transform (100, 50) | 435.5 / 451.0 / 432.6 | 416.3 / 407.7 / 433.1 | -4.4% |

Fuel and Traces are unchanged: Fuel parity holds in every bench report, and `fast-steps.test.ts` compares Traces with the fast path off at every Fuel, allocation and call depth limit and every Fuel Slice.
