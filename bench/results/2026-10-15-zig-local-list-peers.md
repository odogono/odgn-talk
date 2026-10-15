# Benchmark results, 2026-10-15

Commit `74f4307f-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 3, filter collections/list-update, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/list-update | ts | 200.5 | 2.571 | 2.315 | 28553 | 90.0 | 23.8 KiB | 160.7 KiB |  |
| collections/list-update | zig | 11.0 | 0.569 | 0.560 | 28553 | 19.9 | 23.8 KiB |  |  |
| collections/list-update | applescript |  | 0.421 | 0.419 |  |  |  |  |  |
| collections/list-update | gopher-lua |  | 0.0351 | 0.0323 |  |  |  | 22.4 KiB | 106 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

None.
