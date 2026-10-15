# Four-way benchmark after the TS and Zig optimizations

Measured `0aed90d3` on 2026-10-15, Apple M5, Bun 1.4.3, Zig 0.17.0 safe mode. Run medians exclude Load. Overall ratios use the geometric mean across the 21 common workloads.

| Runner | Time / AppleScript | Faster than previous run | Wins vs AppleScript |
| --- | ---: | ---: | ---: |
| Lua (GopherLua) | 0.080× | 1.00× | 21/21 |
| Zig Core | 0.662× | 1.15× | 12/21 |
| AppleScript | 1.000× | 1.01× | 0/21 |
| TS Core | 2.610× | 1.40× | 5/21 |

The previous report is revision `f51ad856` from 2026-10-14. These are different-session comparisons, not alternating paired tests; peer timings provide a noise reference. AppleScript/Lua use natural language ports, including numeric factors instead of first-class Units. Core correctness requires identical output and Fuel; all overlapping accounting was checked. Native allocation/GC are not measured by this suite. Three repeats for Zig and peers; mitata automatic sampling for TS.

| Workload | Zig ms | TS ms | AppleScript ms | Lua ms |
| --- | ---: | ---: | ---: | ---: |
| collections/iterate | 1.3749 | 10.8365 | 6.0054 | 0.3933 |
| collections/list-append | 0.8671 | 4.7395 | 1.4029 | 0.1769 |
| collections/list-build | 0.1933 | 1.0148 | 0.2253 | 0.0372 |
| collections/list-update | 0.5043 | 3.8429 | 0.3703 | 0.0258 |
| collections/map-build | 0.8632 | 1.0864 | 5.7948 | 0.0784 |
| collections/map-update | 0.1984 | 0.7818 | 3.4988 | 0.0185 |
| core/calls | 0.5876 | 1.9211 | 0.5964 | 0.0710 |
| core/fib | 0.5868 | 2.1743 | 0.4724 | 0.0708 |
| core/lambdas | 0.7708 | 2.7469 | 0.6542 | 0.0850 |
| core/loop | 0.9032 | 2.5437 | 0.1790 | 0.0260 |
| macro/game-tick | 1.2228 | 5.0635 | 1.3409 | 0.1262 |
| macro/report | 1.1793 | 1.6281 | 3.1139 | 0.1267 |
| macro/transform | 0.2912 | 1.8272 | 0.3328 | 0.1225 |
| numbers/add | 0.4235 | 1.5527 | 0.2227 | 0.0264 |
| numbers/divide | 0.3127 | 1.2773 | 0.1862 | 0.0198 |
| numbers/multiply | 0.2711 | 1.0657 | 0.1694 | 0.0183 |
| numbers/quantity | 0.2788 | 1.2416 | 0.1147 | 0.0114 |
| text/build | 0.4117 | 0.7488 | 0.3593 | 0.0640 |
| text/index | 0.6006 | 2.1973 | 0.8541 | 0.1116 |
| text/iterate | 0.5089 | 2.6357 | 3.2648 | 0.1642 |
| text/patterns | 0.5471 | 5.2988 | 15.2517 | 0.2454 |

## Targeted rechecks

Seven-repeat four-way reruns at the same revision confirmed the narrow Zig calls lead: Zig 0.591 ms, AppleScript 0.612 ms (minimums 0.581/0.596 ms). TS collection iteration did not reproduce its full-run slowdown: 5.220 ms on recheck, versus 10.837 ms in the full run and 6.891 ms previously. The full-run table and aggregates above retain the original samples; the recheck is not substituted into the aggregate. TS wins five workloads against AppleScript in the full run and six if this iteration recheck is used. This sensitivity warrants caution around small changes and TS JIT/GC variation.

Largest TS gains against the previous report: Quantity 3.31×, Character indexing 3.23×, division 1.70× and transform 1.67×. Zig Quantity is 1.41× faster, Fibonacci 1.25×, and multiplication 1.21×. Zig remains slower than AppleScript on loop, Fibonacci, lambdas, all four numeric workloads, List update and Text build.

The suite passed all 111 measurements (Zig 30, TS 39, AppleScript 21, Lua 21); Fuel parity held across all 30 shared TS/Zig workloads, and both Cores retained their previous exact Fuel and logical allocation. The common-workload ranking is Lua, Zig, AppleScript, TS. Zig is 1.51× faster than AppleScript and 3.94× faster than TS; Lua is 8.32× faster than Zig.
