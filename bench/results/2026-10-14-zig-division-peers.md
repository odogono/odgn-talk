# Benchmark results, 2026-10-14

Commit `f385603f-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 3, filter numbers, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| numbers/add | ts | 111.8 | 2.526 | 2.298 | 26030 | 97.0 | 31.4 KiB | 199.7 KiB |  |
| numbers/add | zig | 7.0 | 0.759 | 0.742 | 26030 | 29.2 | 31.4 KiB |  |  |
| numbers/add | applescript |  | 0.246 | 0.245 |  |  |  |  |  |
| numbers/add | gopher-lua |  | 0.0279 | 0.0277 |  |  |  | 43.9 KiB | 177 |
| numbers/divide | ts | 88.5 | 2.229 | 2.066 | 18031 | 123.6 | 31.4 KiB | 393.6 KiB |  |
| numbers/divide | zig | 7.3 | 0.499 | 0.495 | 18031 | 27.7 | 31.4 KiB |  |  |
| numbers/divide | applescript |  | 0.206 | 0.202 |  |  |  |  |  |
| numbers/divide | gopher-lua |  | 0.0206 | 0.0198 |  |  |  | 28.3 KiB | 115 |
| numbers/multiply | ts | 95.9 | 1.692 | 1.446 | 18031 | 93.8 | 31.4 KiB | 152.8 KiB |  |
| numbers/multiply | zig | 7.3 | 0.466 | 0.461 | 18031 | 25.9 | 31.4 KiB |  |  |
| numbers/multiply | applescript |  | 0.186 | 0.185 |  |  |  |  |  |
| numbers/multiply | gopher-lua |  | 0.0194 | 0.0193 |  |  |  | 29.1 KiB | 118 |
| numbers/quantity | ts | 144.8 | 4.202 | 3.899 | 14579 | 288.2 | 39.1 KiB | 420.9 KiB |  |
| numbers/quantity | zig | 9.0 | 0.508 | 0.508 | 14579 | 34.9 | 39.1 KiB |  |  |
| numbers/quantity | applescript |  | 0.126 | 0.124 |  |  |  |  |  |
| numbers/quantity | gopher-lua |  | 0.0114 | 0.0114 |  |  |  | 16.5 KiB | 67 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

None.

