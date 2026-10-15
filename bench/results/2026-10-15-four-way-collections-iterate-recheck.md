$ bun bench/ts/src/main.ts --only "zig,ts,applescript,gopher-lua" --filter collections/iterate --count "7" --no-save
Measuring the Zig Core…
Measuring the TS Core…
Measuring AppleScript…
Measuring the Peer Languages on Go (gopher-lua)…
# Benchmark results, 2026-10-15

Commit `0aed90d3` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 7, filter collections/iterate, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | ts | 218.4 | 5.220 | 4.892 | 89459 | 58.3 | 195.6 KiB | 508.2 KiB |  |
| collections/iterate | zig | 13.9 | 1.378 | 1.368 | 89459 | 15.4 | 195.6 KiB |  |  |
| collections/iterate | applescript |  | 5.875 | 5.853 |  |  |  |  |  |
| collections/iterate | gopher-lua |  | 0.391 | 0.390 |  |  |  | 108.9 KiB | 6741 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

None.

