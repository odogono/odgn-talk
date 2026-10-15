Measured the scalar constructor working tree for #937 on parent f51ad856. The companion JSON records source and binary hashes; the paired constructor report describes the experiment and limitations.

# Benchmark results, 2026-10-14

Commit `f51ad856-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 3, filter core, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| core/calls | ts | 154.3 | 3.552 | 2.903 | 46018 | 77.2 | 31.3 KiB | 190.6 KiB |  |
| core/calls | zig | 11.6 | 0.914 | 0.900 | 46018 | 19.9 | 31.3 KiB |  |  |
| core/calls | applescript |  | 0.837 | 0.821 |  |  |  |  |  |
| core/calls | gopher-lua |  | 0.174 | 0.173 |  |  |  | 44.8 KiB | 180 |
| core/fib | ts | 150.1 | 2.938 | 2.560 | 46365 | 63.4 | 46.2 KiB | 185.1 KiB |  |
| core/fib | zig | 9.6 | 0.945 | 0.944 | 46365 | 20.4 | 46.2 KiB |  |  |
| core/fib | applescript |  | 0.673 | 0.619 |  |  |  |  |  |
| core/fib | gopher-lua |  | 0.107 | 0.103 |  |  |  | 64 B | 1 |
| core/fib@slice=10 | ts | 113.6 | 17.627 | 12.990 | 46365 | 380.2 | 46.2 KiB | 541.8 KiB |  |
| core/fib@slice=10 | zig | 9.5 | 6.356 | 6.355 | 46365 | 137.1 | 46.2 KiB |  |  |
| core/fib@slice=100 | ts | 102.6 | 4.057 | 3.248 | 46365 | 87.5 | 46.2 KiB | 49.6 KiB |  |
| core/fib@slice=100 | zig | 9.6 | 1.461 | 1.456 | 46365 | 31.5 | 46.2 KiB |  |  |
| core/fib@slice=1000 | ts | 95.0 | 2.966 | 2.451 | 46365 | 64.0 | 46.2 KiB | 13.9 KiB |  |
| core/fib@slice=1000 | zig | 9.5 | 1.002 | 0.989 | 46365 | 21.6 | 46.2 KiB |  |  |
| core/fib@slice=10000 | ts | 96.8 | 2.705 | 2.357 | 46365 | 58.3 | 46.2 KiB | 0 B |  |
| core/fib@slice=10000 | zig | 11.1 | 0.963 | 0.952 | 46365 | 20.8 | 46.2 KiB |  |  |
| core/lambdas | ts | 206.7 | 7.856 | 5.731 | 58027 | 135.4 | 62.6 KiB | 632.2 KiB |  |
| core/lambdas | zig | 12.7 | 1.391 | 1.138 | 58027 | 24.0 | 62.6 KiB |  |  |
| core/lambdas | applescript |  | 0.939 | 0.897 |  |  |  |  |  |
| core/lambdas | gopher-lua |  | 0.217 | 0.198 |  |  |  | 60.3 KiB | 244 |
| core/loop | ts | 232.9 | 5.597 | 3.049 | 48016 | 116.6 | 62.5 KiB | 314.2 KiB |  |
| core/loop | zig | 9.2 | 1.407 | 1.407 | 48016 | 29.3 | 62.5 KiB |  |  |
| core/loop | applescript |  | 0.259 | 0.256 |  |  |  |  |  |
| core/loop | gopher-lua |  | 0.0615 | 0.0612 |  |  |  | 44.8 KiB | 180 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- core/fib@slice=10 on zig: 137.1 ns/Fuel, 6.0× the median
- core/fib@slice=10 on ts: 380.2 ns/Fuel, 4.6× the median

## Skipped

- core/fib@slice=10 on applescript: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10 on gopher-lua: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=100 on applescript: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=100 on gopher-lua: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=1000 on applescript: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=1000 on gopher-lua: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10000 on applescript: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10000 on gopher-lua: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
