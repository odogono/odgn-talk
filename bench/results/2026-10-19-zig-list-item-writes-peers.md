# Benchmark results, 2026-10-19

Commit `reactor-v0.5.0-79-g3ba52a1d-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host zig cc -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 5, filter collections/list-update, runners zig,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/list-update | zig | 10.4 | 0.352 | 0.350 | 28553 | 12.3 | 23.8 KiB |  |  |
| collections/list-update | applescript |  | 0.373 | 0.366 |  |  |  |  |  |
| collections/list-update | gopher-lua |  | 0.0262 | 0.0256 |  |  |  | 22.4 KiB | 106 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

None.
