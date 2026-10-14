# Benchmark results, 2026-10-14

Commit `8f98a485-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 3, filter collections, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | ts | 174.7 | 5.768 | 5.315 | 89459 | 64.5 | 195.6 KiB | 718.5 KiB |  |
| collections/iterate | zig | 13.6 | 2.145 | 2.141 | 89459 | 24.0 | 195.6 KiB |  |  |
| collections/iterate | applescript |  | 6.025 | 6.024 |  |  |  |  |  |
| collections/iterate | gopher-lua |  | 0.415 | 0.414 |  |  |  | 108.9 KiB | 6741 |
| collections/list-append | ts | 157.6 | 4.530 | 4.138 | 52056 | 87.0 | 78.3 KiB | 576.4 KiB |  |
| collections/list-append | zig | 10.0 | 1.373 | 1.372 | 52056 | 26.4 | 78.3 KiB |  |  |
| collections/list-append | applescript |  | 1.333 | 1.328 |  |  |  |  |  |
| collections/list-append | gopher-lua |  | 0.186 | 0.184 |  |  |  | 203.9 KiB | 4315 |
| collections/list-build | ts | 100.5 | 0.921 | 0.849 | 19091 | 48.3 | 2.9 MiB | 112.0 KiB |  |
| collections/list-build | zig | 7.2 | 0.315 | 0.313 | 19091 | 16.5 | 2.9 MiB |  |  |
| collections/list-build | applescript |  | 0.225 | 0.224 |  |  |  |  |  |
| collections/list-build | gopher-lua |  | 0.0386 | 0.0384 |  |  |  | 35.4 KiB | 1045 |
| collections/list-update | ts | 182.1 | 2.416 | 2.181 | 28553 | 84.6 | 23.8 KiB | 295.3 KiB |  |
| collections/list-update | zig | 10.3 | 0.806 | 0.805 | 28553 | 28.2 | 23.8 KiB |  |  |
| collections/list-update | applescript |  | 0.374 | 0.372 |  |  |  |  |  |
| collections/list-update | gopher-lua |  | 0.0273 | 0.0272 |  |  |  | 22.4 KiB | 106 |
| collections/map-build | ts | 126.5 | 1.032 | 0.936 | 14094 | 73.2 | 24.3 KiB | 79.5 KiB |  |
| collections/map-build | zig | 9.0 | 0.961 | 0.955 | 14094 | 68.2 | 24.3 KiB |  |  |
| collections/map-build | applescript |  | 6.099 | 5.869 |  |  |  |  |  |
| collections/map-build | gopher-lua |  | 0.0833 | 0.0828 |  |  |  | 90.5 KiB | 1291 |
| collections/map-update | ts | 157.6 | 0.855 | 0.763 | 8056 | 106.1 | 12.1 KiB | 38.3 KiB |  |
| collections/map-update | zig | 11.3 | 0.284 | 0.284 | 8056 | 35.2 | 12.1 KiB |  |  |
| collections/map-update | applescript |  | 3.651 | 3.595 |  |  |  |  |  |
| collections/map-update | gopher-lua |  | 0.0195 | 0.0194 |  |  |  | 10.2 KiB | 76 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

None.

