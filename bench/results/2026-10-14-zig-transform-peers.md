# Benchmark results, 2026-10-14

Commit `8f98a485-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 3, filter macro/transform, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| macro/transform | ts | 174.3 | 1.599 | 1.406 | 20664 | 77.4 | 6.1 MiB | 206.5 KiB |  |
| macro/transform | zig | 12.1 | 0.429 | 0.413 | 20664 | 20.7 | 6.1 MiB |  |  |
| macro/transform | applescript |  | 0.403 | 0.399 |  |  |  |  |  |
| macro/transform | gopher-lua |  | 0.130 | 0.130 |  |  |  | 268.0 KiB | 4538 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

None.

