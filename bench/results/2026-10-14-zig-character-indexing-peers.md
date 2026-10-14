# Benchmark results, 2026-10-14

Commit `8f98a485-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 3, filter text, runners zig,ts,gopher-lua,applescript, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| text/build | ts | 86.5 | 0.833 | 0.778 | 28928 | 28.8 | 374.8 KiB | 103.1 KiB |  |
| text/build | zig | 5.9 | 0.477 | 0.476 | 28928 | 16.5 | 374.8 KiB |  |  |
| text/build | applescript |  | 0.363 | 0.360 |  |  |  |  |  |
| text/build | gopher-lua |  | 0.0690 | 0.0667 |  |  |  | 400.8 KiB | 1024 |
| text/graphemes | ts | 96.2 | 5.130 | 4.511 | 43518 | 117.9 | 144.1 KiB | 635.5 KiB |  |
| text/graphemes | zig | 7.6 | 1.400 | 1.397 | 43518 | 32.2 | 144.1 KiB |  |  |
| text/index | ts | 121.5 | 5.396 | 5.049 | 26640 | 202.6 | 49.9 KiB | 838.2 KiB |  |
| text/index | zig | 7.9 | 0.827 | 0.821 | 26640 | 31.0 | 49.9 KiB |  |  |
| text/index | applescript |  | 0.895 | 0.881 |  |  |  |  |  |
| text/index | gopher-lua |  | 0.119 | 0.118 |  |  |  | 29.3 KiB | 1055 |
| text/iterate | ts | 85.7 | 2.355 | 2.063 | 30318 | 77.7 | 93.0 KiB | 368.7 KiB |  |
| text/iterate | zig | 7.2 | 0.751 | 0.750 | 30318 | 24.8 | 93.0 KiB |  |  |
| text/iterate | applescript |  | 3.363 | 3.338 |  |  |  |  |  |
| text/iterate | gopher-lua |  | 0.176 | 0.176 |  |  |  | 187.3 KiB | 9847 |
| text/patterns | ts | 109.2 | 5.526 | 5.139 | 13818 | 399.9 | 225.9 KiB | 1.3 MiB |  |
| text/patterns | zig | 7.6 | 0.646 | 0.641 | 13818 | 46.8 | 225.9 KiB |  |  |
| text/patterns | applescript |  | 15.770 | 15.732 |  |  |  |  |  |
| text/patterns | gopher-lua |  | 0.261 | 0.260 |  |  |  | 390.8 KiB | 17736 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- text/patterns on ts: 399.9 ns/Fuel, 3.4× the median

## Skipped

- text/graphemes on gopher-lua: Unicode grapheme segmentation has no shared API across the pinned peers; text/iterate and text/index compare ASCII.
- text/graphemes on applescript: Unicode grapheme segmentation has no shared API across the pinned peers; text/iterate and text/index compare ASCII.
