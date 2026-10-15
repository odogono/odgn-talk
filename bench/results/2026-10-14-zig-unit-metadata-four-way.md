# Benchmark results, 2026-10-14

Commit `f51ad856-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 3, filter numbers, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| numbers/add | ts | 102.8 | 2.255 | 2.090 | 26030 | 86.6 | 31.4 KiB | 179.7 KiB |  |
| numbers/add | zig | 6.5 | 0.540 | 0.499 | 26030 | 20.8 | 31.4 KiB |  |  |
| numbers/add | applescript |  | 0.223 | 0.222 |  |  |  |  |  |
| numbers/add | gopher-lua |  | 0.0266 | 0.0265 |  |  |  | 43.9 KiB | 177 |
| numbers/divide | ts | 80.5 | 2.068 | 1.942 | 18031 | 114.7 | 31.4 KiB | 357.4 KiB |  |
| numbers/divide | zig | 6.6 | 0.355 | 0.351 | 18031 | 19.7 | 31.4 KiB |  |  |
| numbers/divide | applescript |  | 0.187 | 0.187 |  |  |  |  |  |
| numbers/divide | gopher-lua |  | 0.0198 | 0.0198 |  |  |  | 28.3 KiB | 115 |
| numbers/multiply | ts | 87.6 | 1.553 | 1.361 | 18031 | 86.1 | 31.4 KiB | 194.1 KiB |  |
| numbers/multiply | zig | 6.6 | 0.318 | 0.318 | 18031 | 17.6 | 31.4 KiB |  |  |
| numbers/multiply | applescript |  | 0.170 | 0.170 |  |  |  |  |  |
| numbers/multiply | gopher-lua |  | 0.0184 | 0.0183 |  |  |  | 29.1 KiB | 118 |
| numbers/quantity | ts | 137.6 | 3.896 | 3.674 | 14579 | 267.2 | 39.1 KiB | 352.7 KiB |  |
| numbers/quantity | zig | 8.3 | 0.306 | 0.305 | 14579 | 21.0 | 39.1 KiB |  |  |
| numbers/quantity | applescript |  | 0.116 | 0.115 |  |  |  |  |  |
| numbers/quantity | gopher-lua |  | 0.0113 | 0.0113 |  |  |  | 16.5 KiB | 67 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

None.
