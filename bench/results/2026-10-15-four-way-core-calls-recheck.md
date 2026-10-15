$ bun bench/ts/src/main.ts --only "zig,ts,applescript,gopher-lua" --filter core/calls --count "7" --no-save
Measuring the Zig Core…
Measuring the TS Core…
Measuring AppleScript…
Measuring the Peer Languages on Go (gopher-lua)…
# Benchmark results, 2026-10-15

Commit `0aed90d3` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 7, filter core/calls, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| core/calls | ts | 128.2 | 1.786 | 1.671 | 46018 | 38.8 | 31.3 KiB | 169.4 KiB |  |
| core/calls | zig | 7.6 | 0.591 | 0.581 | 46018 | 12.8 | 31.3 KiB |  |  |
| core/calls | applescript |  | 0.612 | 0.596 |  |  |  |  |  |
| core/calls | gopher-lua |  | 0.0701 | 0.0696 |  |  |  | 44.8 KiB | 180 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

None.

