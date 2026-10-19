# Benchmark results, 2026-10-19

Commit `reactor-v0.5.0-80-g6d39b827-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host zig cc -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 5, filter numbers/, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| numbers/add | ts | 101.1 | 1.470 | 1.389 | 26030 | 56.5 | 31.4 KiB | 88.9 KiB |  |
| numbers/add | zig | 7.0 | 0.128 | 0.128 | 26030 | 4.9 | 31.4 KiB |  |  |
| numbers/add | applescript |  | 0.224 | 0.222 |  |  |  |  |  |
| numbers/add | gopher-lua |  | 0.0263 | 0.0263 |  |  |  | 43.9 KiB | 177 |
| numbers/divide | ts | 84.2 | 1.226 | 1.141 | 18031 | 68.0 | 31.4 KiB | 341.7 KiB |  |
| numbers/divide | zig | 7.0 | 0.115 | 0.114 | 18031 | 6.4 | 31.4 KiB |  |  |
| numbers/divide | applescript |  | 0.189 | 0.188 |  |  |  |  |  |
| numbers/divide | gopher-lua |  | 0.0198 | 0.0197 |  |  |  | 28.3 KiB | 115 |
| numbers/multiply | ts | 86.8 | 1.026 | 0.965 | 18031 | 56.9 | 31.4 KiB | 188.1 KiB |  |
| numbers/multiply | zig | 7.1 | 0.0821 | 0.0820 | 18031 | 4.6 | 31.4 KiB |  |  |
| numbers/multiply | applescript |  | 0.170 | 0.169 |  |  |  |  |  |
| numbers/multiply | gopher-lua |  | 0.0181 | 0.0181 |  |  |  | 29.1 KiB | 118 |
| numbers/quantity | ts | 109.4 | 1.079 | 0.985 | 14579 | 74.0 | 39.1 KiB | 195.7 KiB |  |
| numbers/quantity | zig | 8.8 | 0.116 | 0.116 | 14579 | 8.0 | 39.1 KiB |  |  |
| numbers/quantity | applescript |  | 0.116 | 0.116 |  |  |  |  |  |
| numbers/quantity | gopher-lua |  | 0.0114 | 0.0114 |  |  |  | 16.5 KiB | 67 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

None.
