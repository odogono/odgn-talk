# Benchmark results, 2026-10-15

Commit `151f2b8e-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 3, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | ts | 263.6 | 8.050 | 7.482 | 89459 | 90.0 | 195.6 KiB | 2.2 MiB |  |
| collections/iterate | zig | 14.7 | 1.486 | 1.463 | 89459 | 16.6 | 195.6 KiB |  |  |
| collections/iterate | applescript |  | 7.312 | 7.143 |  |  |  |  |  |
| collections/iterate | gopher-lua |  | 0.443 | 0.438 |  |  |  | 108.9 KiB | 6741 |
| collections/list-append | ts | 203.6 | 8.933 | 5.644 | 52056 | 171.6 | 78.3 KiB | 837.5 KiB |  |
| collections/list-append | zig | 10.9 | 0.986 | 0.975 | 52056 | 18.9 | 78.3 KiB |  |  |
| collections/list-append | applescript |  | 1.553 | 1.509 |  |  |  |  |  |
| collections/list-append | gopher-lua |  | 0.201 | 0.199 |  |  |  | 203.9 KiB | 4315 |
| collections/list-build | ts | 124.3 | 1.352 | 1.210 | 19091 | 70.8 | 2.9 MiB | 367.7 KiB |  |
| collections/list-build | zig | 8.0 | 0.225 | 0.213 | 19091 | 11.8 | 2.9 MiB |  |  |
| collections/list-build | applescript |  | 0.255 | 0.254 |  |  |  |  |  |
| collections/list-build | gopher-lua |  | 0.0415 | 0.0411 |  |  |  | 35.4 KiB | 1045 |
| collections/list-update | ts | 216.9 | 5.774 | 3.913 | 28553 | 202.2 | 23.8 KiB | 757.0 KiB |  |
| collections/list-update | zig | 10.9 | 0.555 | 0.547 | 28553 | 19.4 | 23.8 KiB |  |  |
| collections/list-update | applescript |  | 0.425 | 0.415 |  |  |  |  |  |
| collections/list-update | gopher-lua |  | 0.0271 | 0.0266 |  |  |  | 22.4 KiB | 106 |
| collections/map-build | ts | 163.7 | 1.373 | 1.219 | 14094 | 97.4 | 24.3 KiB | 216.9 KiB |  |
| collections/map-build | zig | 10.0 | 0.955 | 0.933 | 14094 | 67.8 | 24.3 KiB |  |  |
| collections/map-build | applescript |  | 7.096 | 6.832 |  |  |  |  |  |
| collections/map-build | gopher-lua |  | 0.0855 | 0.0788 |  |  |  | 90.5 KiB | 1291 |
| collections/map-update | ts | 202.0 | 1.500 | 0.947 | 8056 | 186.2 | 12.1 KiB | 85.0 KiB |  |
| collections/map-update | zig | 11.7 | 0.212 | 0.211 | 8056 | 26.4 | 12.1 KiB |  |  |
| collections/map-update | applescript |  | 4.603 | 4.467 |  |  |  |  |  |
| collections/map-update | gopher-lua |  | 0.0194 | 0.0192 |  |  |  | 10.2 KiB | 76 |
| core/calls | ts | 143.2 | 2.779 | 2.524 | 46018 | 60.4 | 31.3 KiB | 165.7 KiB |  |
| core/calls | zig | 8.5 | 0.644 | 0.642 | 46018 | 14.0 | 31.3 KiB |  |  |
| core/calls | applescript |  | 0.673 | 0.666 |  |  |  |  |  |
| core/calls | gopher-lua |  | 0.0806 | 0.0790 |  |  |  | 44.8 KiB | 180 |
| core/fib | ts | 137.8 | 2.564 | 2.156 | 46365 | 55.3 | 46.2 KiB | 250.0 KiB |  |
| core/fib | zig | 7.9 | 0.678 | 0.672 | 46365 | 14.6 | 46.2 KiB |  |  |
| core/fib | applescript |  | 0.565 | 0.544 |  |  |  |  |  |
| core/fib | gopher-lua |  | 0.0799 | 0.0785 |  |  |  | 63 B | 1 |
| core/fib@slice=10 | ts | 103.8 | 11.253 | 9.835 | 46365 | 242.7 | 46.2 KiB | 1.1 MiB |  |
| core/fib@slice=10 | zig | 7.7 | 5.008 | 4.909 | 46365 | 108.0 | 46.2 KiB |  |  |
| core/fib@slice=100 | ts | 88.2 | 3.083 | 2.796 | 46365 | 66.5 | 46.2 KiB | 34.4 KiB |  |
| core/fib@slice=100 | zig | 7.7 | 1.113 | 1.097 | 46365 | 24.0 | 46.2 KiB |  |  |
| core/fib@slice=1000 | ts | 87.1 | 2.257 | 2.057 | 46365 | 48.7 | 46.2 KiB | 57 B |  |
| core/fib@slice=1000 | zig | 7.6 | 0.706 | 0.699 | 46365 | 15.2 | 46.2 KiB |  |  |
| core/fib@slice=10000 | ts | 86.3 | 2.166 | 1.967 | 46365 | 46.7 | 46.2 KiB | 3.7 KiB |  |
| core/fib@slice=10000 | zig | 7.8 | 0.675 | 0.667 | 46365 | 14.6 | 46.2 KiB |  |  |
| core/lambdas | ts | 180.9 | 4.241 | 3.701 | 58027 | 73.1 | 62.6 KiB | 487.0 KiB |  |
| core/lambdas | zig | 9.8 | 0.843 | 0.837 | 58027 | 14.5 | 62.6 KiB |  |  |
| core/lambdas | applescript |  | 0.735 | 0.726 |  |  |  |  |  |
| core/lambdas | gopher-lua |  | 0.0945 | 0.0944 |  |  |  | 60.3 KiB | 244 |
| core/loop | ts | 111.9 | 3.004 | 2.576 | 48016 | 62.6 | 62.5 KiB | 263.3 KiB |  |
| core/loop | zig | 7.3 | 0.978 | 0.960 | 48016 | 20.4 | 62.5 KiB |  |  |
| core/loop | applescript |  | 0.205 | 0.202 |  |  |  |  |  |
| core/loop | gopher-lua |  | 0.0288 | 0.0288 |  |  |  | 44.8 KiB | 180 |
| host/conversion | ts | 204.9 | 9.952 | 9.487 | 25018 | 397.8 | 220.3 KiB | 1.5 MiB |  |
| host/immediate | ts | 139.5 | 2.302 | 2.099 | 13518 | 170.3 | 15.7 KiB | 78.3 KiB |  |
| host/properties | ts | 120.3 | 1.848 | 1.525 | 9018 | 204.9 | 15.7 KiB | 126.4 KiB |  |
| host/pump | ts | 21.7 | 0.00705 | 0.00676 | 7 | 1007.6 | 0 B | 3.5 KiB |  |
| host/pump | zig | 3.1 | 0.00174 | 0.00173 | 7 | 248.0 | 0 B |  |  |
| host/suspending | ts | 147.3 | 5.028 | 4.591 | 13518 | 371.9 | 15.7 KiB | 616.3 KiB |  |
| lifecycle/load-large | ts | 15641.1 | 0.703 | 0.650 | 4609 | 152.5 | 16.3 KiB | 240 B |  |
| lifecycle/load-large | zig | 837.9 | 0.153 | 0.152 | 4609 | 33.1 | 16.3 KiB |  |  |
| lifecycle/load-small | ts | 34.1 | 0.00760 | 0.00721 | 7 | 1085.1 | 0 B | 2.8 KiB |  |
| lifecycle/load-small | zig | 3.0 | 0.00175 | 0.00175 | 7 | 250.0 | 0 B |  |  |
| lifecycle/restore | ts | 253.5 | 8.265 | 7.577 | 8015 | 1031.2 | 7.8 KiB | 24.0 KiB |  |
| lifecycle/rollback | ts | 276.2 | 69.165 | 66.464 | 102023 | 677.9 | 39.9 KiB | 14.7 KiB |  |
| macro/game-tick | ts | 216.8 | 6.143 | 5.734 | 67042 | 91.6 | 78.4 KiB | 10.0 KiB |  |
| macro/game-tick | zig | 13.7 | 1.312 | 1.308 | 67042 | 19.6 | 78.4 KiB |  |  |
| macro/game-tick | applescript |  | 1.559 | 1.512 |  |  |  |  |  |
| macro/game-tick | gopher-lua |  | 0.135 | 0.133 |  |  |  | 28.7 KiB | 128 |
| macro/report | ts | 126.5 | 2.120 | 1.965 | 86555 | 24.5 | 1.2 MiB | 2.3 MiB |  |
| macro/report | zig | 8.1 | 1.270 | 1.260 | 86555 | 14.7 | 1.2 MiB |  |  |
| macro/report | applescript |  | 3.903 | 3.760 |  |  |  |  |  |
| macro/report | gopher-lua |  | 0.139 | 0.137 |  |  |  | 33.1 KiB | 1291 |
| macro/transform | ts | 175.5 | 3.266 | 3.048 | 20664 | 158.1 | 6.1 MiB | 1.2 KiB |  |
| macro/transform | zig | 11.8 | 0.287 | 0.286 | 20664 | 13.9 | 6.1 MiB |  |  |
| macro/transform | applescript |  | 0.390 | 0.385 |  |  |  |  |  |
| macro/transform | gopher-lua |  | 0.137 | 0.131 |  |  |  | 268.0 KiB | 4538 |
| messaging/joins | ts | 242.5 | 21.505 | 20.387 | 127218 | 169.0 | 239.1 KiB | 6.2 KiB |  |
| messaging/parents | ts | 164.4 | 16.835 | 15.115 | 67518 | 249.3 | 93.8 KiB | 1.3 KiB |  |
| messaging/sends | ts | 177.5 | 17.456 | 16.829 | 67518 | 258.5 | 93.8 KiB | 422.6 KiB |  |
| messaging/suspend | ts | 109.1 | 17.599 | 16.782 | 48018 | 366.5 | 31.3 KiB | 3.3 KiB |  |
| messaging/suspend | zig | 7.1 | 2.962 | 2.914 | 48018 | 61.7 | 31.3 KiB |  |  |
| numbers/add | ts | 119.4 | 2.433 | 2.217 | 26030 | 93.5 | 31.4 KiB | 170.6 KiB |  |
| numbers/add | zig | 7.1 | 0.465 | 0.461 | 26030 | 17.9 | 31.4 KiB |  |  |
| numbers/add | applescript |  | 0.290 | 0.288 |  |  |  |  |  |
| numbers/add | gopher-lua |  | 0.0293 | 0.0292 |  |  |  | 43.9 KiB | 177 |
| numbers/divide | ts | 88.4 | 1.771 | 1.613 | 18031 | 98.2 | 31.4 KiB | 383.0 KiB |  |
| numbers/divide | zig | 7.3 | 0.337 | 0.337 | 18031 | 18.7 | 31.4 KiB |  |  |
| numbers/divide | applescript |  | 0.240 | 0.222 |  |  |  |  |  |
| numbers/divide | gopher-lua |  | 0.0219 | 0.0218 |  |  |  | 28.3 KiB | 115 |
| numbers/multiply | ts | 92.4 | 1.516 | 1.364 | 18031 | 84.1 | 31.4 KiB | 192.9 KiB |  |
| numbers/multiply | zig | 7.2 | 0.293 | 0.292 | 18031 | 16.3 | 31.4 KiB |  |  |
| numbers/multiply | applescript |  | 0.215 | 0.200 |  |  |  |  |  |
| numbers/multiply | gopher-lua |  | 0.0205 | 0.0203 |  |  |  | 29.1 KiB | 118 |
| numbers/quantity | ts | 162.6 | 3.227 | 2.901 | 14579 | 221.3 | 39.1 KiB | 229.9 KiB |  |
| numbers/quantity | zig | 9.2 | 0.298 | 0.297 | 14579 | 20.5 | 39.1 KiB |  |  |
| numbers/quantity | applescript |  | 0.146 | 0.144 |  |  |  |  |  |
| numbers/quantity | gopher-lua |  | 0.0127 | 0.0125 |  |  |  | 16.5 KiB | 67 |
| text/build | ts | 103.9 | 1.146 | 1.043 | 28928 | 39.6 | 374.8 KiB | 201.7 KiB |  |
| text/build | zig | 6.3 | 0.438 | 0.437 | 28928 | 15.1 | 374.8 KiB |  |  |
| text/build | applescript |  | 0.492 | 0.470 |  |  |  |  |  |
| text/build | gopher-lua |  | 0.0739 | 0.0726 |  |  |  | 400.8 KiB | 1024 |
| text/graphemes | ts | 109.4 | 5.740 | 5.284 | 43518 | 131.9 | 144.1 KiB | 441.8 KiB |  |
| text/graphemes | zig | 8.2 | 1.100 | 1.080 | 43518 | 25.3 | 144.1 KiB |  |  |
| text/index | ts | 123.0 | 3.505 | 3.169 | 26640 | 131.6 | 49.9 KiB | 494.8 KiB |  |
| text/index | zig | 8.4 | 0.655 | 0.642 | 26640 | 24.6 | 49.9 KiB |  |  |
| text/index | applescript |  | 1.218 | 1.215 |  |  |  |  |  |
| text/index | gopher-lua |  | 0.138 | 0.125 |  |  |  | 29.3 KiB | 1055 |
| text/iterate | ts | 131.8 | 3.667 | 3.377 | 30318 | 120.9 | 93.0 KiB | 903.2 KiB |  |
| text/iterate | zig | 7.6 | 0.558 | 0.551 | 30318 | 18.4 | 93.0 KiB |  |  |
| text/iterate | applescript |  | 4.683 | 4.490 |  |  |  |  |  |
| text/iterate | gopher-lua |  | 0.185 | 0.184 |  |  |  | 187.3 KiB | 9847 |
| text/patterns | ts | 134.6 | 6.370 | 5.988 | 13818 | 461.0 | 225.9 KiB | 2.1 MiB |  |
| text/patterns | zig | 8.1 | 0.618 | 0.603 | 13818 | 44.7 | 225.9 KiB |  |  |
| text/patterns | applescript |  | 18.826 | 18.556 |  |  |  |  |  |
| text/patterns | gopher-lua |  | 0.274 | 0.273 |  |  |  | 390.8 KiB | 17736 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- core/fib@slice=10 on zig: 108.0 ns/Fuel, 5.6× the median
- collections/map-build on zig: 67.8 ns/Fuel, 3.5× the median
- host/pump on zig: 248.0 ns/Fuel, 12.9× the median
- messaging/suspend on zig: 61.7 ns/Fuel, 3.2× the median
- lifecycle/load-small on zig: 250.0 ns/Fuel, 13.0× the median
- text/patterns on ts: 461.0 ns/Fuel, 3.2× the median
- host/pump on ts: 1007.6 ns/Fuel, 7.1× the median
- lifecycle/load-small on ts: 1085.1 ns/Fuel, 7.6× the median
- lifecycle/rollback on ts: 677.9 ns/Fuel, 4.8× the median

## Skipped

- core/fib@slice=10 on applescript: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10 on gopher-lua: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=100 on applescript: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=100 on gopher-lua: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=1000 on applescript: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=1000 on gopher-lua: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10000 on applescript: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10000 on gopher-lua: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- text/graphemes on applescript: Unicode grapheme segmentation has no shared API across the pinned peers; text/iterate and text/index compare ASCII.
- text/graphemes on gopher-lua: Unicode grapheme segmentation has no shared API across the pinned peers; text/iterate and text/index compare ASCII.
- host/immediate on zig: The native benchmark Host does not yet install immediate bindings; this is a runner limitation, not a Core limitation.
- host/immediate on applescript: NorthTalk embedding API; no peer counterpart.
- host/immediate on gopher-lua: NorthTalk embedding API; no peer counterpart.
- host/suspending on zig: The native benchmark Host does not yet install suspending bindings; this is a runner limitation, not a Core limitation.
- host/suspending on applescript: NorthTalk embedding API; no peer counterpart.
- host/suspending on gopher-lua: NorthTalk embedding API; no peer counterpart.
- host/properties on zig: The native benchmark Host does not yet install properties bindings; this is a runner limitation, not a Core limitation.
- host/properties on applescript: NorthTalk embedding API; no peer counterpart.
- host/properties on gopher-lua: NorthTalk embedding API; no peer counterpart.
- host/conversion on zig: The native benchmark Host does not yet install conversion bindings; this is a runner limitation, not a Core limitation.
- host/conversion on applescript: NorthTalk embedding API; no peer counterpart.
- host/conversion on gopher-lua: NorthTalk embedding API; no peer counterpart.
- host/pump on applescript: NorthTalk embedding API; no peer counterpart.
- host/pump on gopher-lua: NorthTalk embedding API; no peer counterpart.
- messaging/sends on zig: The native benchmark Host does not yet install partner bindings; this is a runner limitation, not a Core limitation.
- messaging/sends on applescript: NorthTalk embedding API; no peer counterpart.
- messaging/sends on gopher-lua: NorthTalk embedding API; no peer counterpart.
- messaging/parents on zig: The native benchmark Host does not yet install parents bindings; this is a runner limitation, not a Core limitation.
- messaging/parents on applescript: NorthTalk embedding API; no peer counterpart.
- messaging/parents on gopher-lua: NorthTalk embedding API; no peer counterpart.
- messaging/joins on zig: The native benchmark Host does not yet install partner bindings; this is a runner limitation, not a Core limitation.
- messaging/joins on applescript: NorthTalk embedding API; no peer counterpart.
- messaging/joins on gopher-lua: NorthTalk embedding API; no peer counterpart.
- messaging/suspend on applescript: NorthTalk embedding API; no peer counterpart.
- messaging/suspend on gopher-lua: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-small on applescript: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-small on gopher-lua: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-large on applescript: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-large on gopher-lua: NorthTalk embedding API; no peer counterpart.
- lifecycle/restore on zig: The native benchmark Host does not yet install restore bindings; this is a runner limitation, not a Core limitation.
- lifecycle/restore on applescript: NorthTalk embedding API; no peer counterpart.
- lifecycle/restore on gopher-lua: NorthTalk embedding API; no peer counterpart.
- lifecycle/rollback on zig: The native benchmark Host does not yet install suspending bindings; this is a runner limitation, not a Core limitation.
- lifecycle/rollback on applescript: NorthTalk embedding API; no peer counterpart.
- lifecycle/rollback on gopher-lua: NorthTalk embedding API; no peer counterpart.
