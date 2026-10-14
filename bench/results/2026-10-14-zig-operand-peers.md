# Benchmark results, 2026-10-14

Commit `774923de-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 3, filter core, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| core/calls | ts | 129.2 | 2.647 | 2.477 | 46018 | 57.5 | 31.3 KiB | 123.5 KiB |  |
| core/calls | zig | 7.7 | 0.706 | 0.705 | 46018 | 15.3 | 31.3 KiB |  |  |
| core/calls | applescript |  | 0.599 | 0.599 |  |  |  |  |  |
| core/calls | gopher-lua |  | 0.0710 | 0.0708 |  |  |  | 44.8 KiB | 180 |
| core/fib | ts | 114.9 | 2.343 | 1.921 | 46365 | 50.5 | 46.2 KiB | 145.4 KiB |  |
| core/fib | zig | 7.1 | 0.755 | 0.752 | 46365 | 16.3 | 46.2 KiB |  |  |
| core/fib | applescript |  | 0.472 | 0.471 |  |  |  |  |  |
| core/fib | gopher-lua |  | 0.0730 | 0.0719 |  |  |  | 63 B | 1 |
| core/fib@slice=10 | ts | 90.6 | 9.944 | 8.887 | 46365 | 214.5 | 46.2 KiB | 898.3 KiB |  |
| core/fib@slice=10 | zig | 7.1 | 4.755 | 4.694 | 46365 | 102.6 | 46.2 KiB |  |  |
| core/fib@slice=100 | ts | 78.0 | 2.900 | 2.707 | 46365 | 62.5 | 46.2 KiB | 26.5 KiB |  |
| core/fib@slice=100 | zig | 7.1 | 1.164 | 1.164 | 46365 | 25.1 | 46.2 KiB |  |  |
| core/fib@slice=1000 | ts | 77.5 | 2.204 | 2.057 | 46365 | 47.5 | 46.2 KiB | 7.5 KiB |  |
| core/fib@slice=1000 | zig | 7.1 | 0.806 | 0.803 | 46365 | 17.4 | 46.2 KiB |  |  |
| core/fib@slice=10000 | ts | 75.8 | 2.115 | 1.995 | 46365 | 45.6 | 46.2 KiB | 10.6 KiB |  |
| core/fib@slice=10000 | zig | 7.1 | 0.759 | 0.759 | 46365 | 16.4 | 46.2 KiB |  |  |
| core/lambdas | ts | 158.4 | 3.988 | 3.512 | 58027 | 68.7 | 62.6 KiB | 558.0 KiB |  |
| core/lambdas | zig | 8.8 | 0.960 | 0.959 | 58027 | 16.5 | 62.6 KiB |  |  |
| core/lambdas | applescript |  | 0.646 | 0.646 |  |  |  |  |  |
| core/lambdas | gopher-lua |  | 0.0852 | 0.0851 |  |  |  | 60.3 KiB | 244 |
| core/loop | ts | 99.5 | 2.910 | 2.670 | 48016 | 60.6 | 62.5 KiB | 306.9 KiB |  |
| core/loop | zig | 6.7 | 1.124 | 1.119 | 48016 | 23.4 | 62.5 KiB |  |  |
| core/loop | applescript |  | 0.180 | 0.180 |  |  |  |  |  |
| core/loop | gopher-lua |  | 0.0260 | 0.0260 |  |  |  | 44.8 KiB | 180 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- core/fib@slice=10 on zig: 102.6 ns/Fuel, 6.0× the median
- core/fib@slice=10 on ts: 214.5 ns/Fuel, 3.6× the median

## Skipped

- core/fib@slice=10 on applescript: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10 on gopher-lua: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=100 on applescript: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=100 on gopher-lua: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=1000 on applescript: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=1000 on gopher-lua: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10000 on applescript: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10000 on gopher-lua: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
