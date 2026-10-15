# Benchmark results, 2026-10-15

Commit `151f2b8e-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 3, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | ts | 273.8 | 7.702 | 7.294 | 89459 | 86.1 | 195.6 KiB | 2.0 MiB |  |
| collections/iterate | zig | 15.2 | 1.552 | 1.548 | 89459 | 17.4 | 195.6 KiB |  |  |
| collections/iterate | applescript |  | 6.513 | 6.512 |  |  |  |  |  |
| collections/iterate | gopher-lua |  | 0.439 | 0.438 |  |  |  | 108.9 KiB | 6741 |
| collections/list-append | ts | 207.3 | 6.764 | 5.477 | 52056 | 129.9 | 78.3 KiB | 871.7 KiB |  |
| collections/list-append | zig | 11.2 | 0.984 | 0.964 | 52056 | 18.9 | 78.3 KiB |  |  |
| collections/list-append | applescript |  | 1.630 | 1.595 |  |  |  |  |  |
| collections/list-append | gopher-lua |  | 0.197 | 0.196 |  |  |  | 203.9 KiB | 4315 |
| collections/list-build | ts | 142.3 | 1.330 | 1.211 | 19091 | 69.7 | 2.9 MiB | 293.0 KiB |  |
| collections/list-build | zig | 8.1 | 0.217 | 0.216 | 19091 | 11.4 | 2.9 MiB |  |  |
| collections/list-build | applescript |  | 0.249 | 0.246 |  |  |  |  |  |
| collections/list-build | gopher-lua |  | 0.0413 | 0.0413 |  |  |  | 35.4 KiB | 1045 |
| collections/list-update | ts | 224.5 | 4.600 | 2.879 | 28553 | 161.1 | 23.8 KiB | 468.9 KiB |  |
| collections/list-update | zig | 11.4 | 0.578 | 0.566 | 28553 | 20.3 | 23.8 KiB |  |  |
| collections/list-update | applescript |  | 0.405 | 0.403 |  |  |  |  |  |
| collections/list-update | gopher-lua |  | 0.0289 | 0.0285 |  |  |  | 22.4 KiB | 106 |
| collections/map-build | ts | 171.2 | 1.333 | 1.168 | 14094 | 94.6 | 24.3 KiB | 264.0 KiB |  |
| collections/map-build | zig | 10.1 | 0.992 | 0.952 | 14094 | 70.4 | 24.3 KiB |  |  |
| collections/map-build | applescript |  | 6.375 | 6.283 |  |  |  |  |  |
| collections/map-build | gopher-lua |  | 0.0888 | 0.0867 |  |  |  | 90.5 KiB | 1291 |
| collections/map-update | ts | 232.3 | 1.127 | 1.007 | 8056 | 139.9 | 12.1 KiB | 126.9 KiB |  |
| collections/map-update | zig | 12.4 | 0.221 | 0.220 | 8056 | 27.4 | 12.1 KiB |  |  |
| collections/map-update | applescript |  | 4.433 | 3.693 |  |  |  |  |  |
| collections/map-update | gopher-lua |  | 0.0238 | 0.0209 |  |  |  | 10.2 KiB | 76 |
| core/calls | ts | 138.5 | 2.672 | 2.396 | 46018 | 58.1 | 31.3 KiB | 157.8 KiB |  |
| core/calls | zig | 9.0 | 0.681 | 0.680 | 46018 | 14.8 | 31.3 KiB |  |  |
| core/calls | applescript |  | 0.659 | 0.657 |  |  |  |  |  |
| core/calls | gopher-lua |  | 0.0872 | 0.0851 |  |  |  | 44.8 KiB | 180 |
| core/fib | ts | 147.3 | 2.508 | 2.011 | 46365 | 54.1 | 46.2 KiB | 193.9 KiB |  |
| core/fib | zig | 8.8 | 0.716 | 0.684 | 46365 | 15.4 | 46.2 KiB |  |  |
| core/fib | applescript |  | 0.527 | 0.517 |  |  |  |  |  |
| core/fib | gopher-lua |  | 0.0797 | 0.0786 |  |  |  | 63 B | 1 |
| core/fib@slice=10 | ts | 108.4 | 11.979 | 10.540 | 46365 | 258.4 | 46.2 KiB | 950.2 KiB |  |
| core/fib@slice=10 | zig | 8.1 | 5.214 | 5.152 | 46365 | 112.5 | 46.2 KiB |  |  |
| core/fib@slice=100 | ts | 91.8 | 3.225 | 2.904 | 46365 | 69.6 | 46.2 KiB | 30.3 KiB |  |
| core/fib@slice=100 | zig | 8.9 | 1.262 | 1.188 | 46365 | 27.2 | 46.2 KiB |  |  |
| core/fib@slice=1000 | ts | 87.3 | 2.174 | 1.970 | 46365 | 46.9 | 46.2 KiB | 215 B |  |
| core/fib@slice=1000 | zig | 8.2 | 0.753 | 0.732 | 46365 | 16.2 | 46.2 KiB |  |  |
| core/fib@slice=10000 | ts | 84.9 | 2.124 | 1.899 | 46365 | 45.8 | 46.2 KiB | 4.7 KiB |  |
| core/fib@slice=10000 | zig | 8.4 | 0.726 | 0.689 | 46365 | 15.6 | 46.2 KiB |  |  |
| core/lambdas | ts | 180.1 | 3.915 | 3.354 | 58027 | 67.5 | 62.6 KiB | 405.5 KiB |  |
| core/lambdas | zig | 10.3 | 0.889 | 0.882 | 58027 | 15.3 | 62.6 KiB |  |  |
| core/lambdas | applescript |  | 0.777 | 0.745 |  |  |  |  |  |
| core/lambdas | gopher-lua |  | 0.104 | 0.0967 |  |  |  | 60.3 KiB | 244 |
| core/loop | ts | 114.8 | 2.893 | 2.569 | 48016 | 60.3 | 62.5 KiB | 212.0 KiB |  |
| core/loop | zig | 7.9 | 0.982 | 0.972 | 48016 | 20.5 | 62.5 KiB |  |  |
| core/loop | applescript |  | 0.199 | 0.195 |  |  |  |  |  |
| core/loop | gopher-lua |  | 0.0322 | 0.0307 |  |  |  | 44.8 KiB | 180 |
| host/conversion | ts | 183.9 | 10.090 | 9.530 | 25018 | 403.3 | 220.3 KiB | 1.2 MiB |  |
| host/immediate | ts | 127.5 | 2.180 | 2.008 | 13518 | 161.3 | 15.7 KiB | 70.6 KiB |  |
| host/properties | ts | 119.1 | 2.106 | 1.551 | 9018 | 233.5 | 15.7 KiB | 209.9 KiB |  |
| host/pump | ts | 22.7 | 0.00789 | 0.00704 | 7 | 1127.2 | 0 B | 2.5 KiB |  |
| host/pump | zig | 3.2 | 0.00179 | 0.00179 | 7 | 256.2 | 0 B |  |  |
| host/suspending | ts | 133.3 | 5.083 | 4.470 | 13518 | 376.1 | 15.7 KiB | 305.7 KiB |  |
| lifecycle/load-large | ts | 16700.9 | 0.703 | 0.637 | 4609 | 152.5 | 16.3 KiB | 159 B |  |
| lifecycle/load-large | zig | 846.9 | 0.155 | 0.155 | 4609 | 33.7 | 16.3 KiB |  |  |
| lifecycle/load-small | ts | 37.0 | 0.00766 | 0.00688 | 7 | 1093.8 | 0 B | 3.3 KiB |  |
| lifecycle/load-small | zig | 3.1 | 0.00178 | 0.00177 | 7 | 254.4 | 0 B |  |  |
| lifecycle/restore | ts | 262.6 | 8.062 | 7.445 | 8015 | 1005.9 | 7.8 KiB | 67.3 KiB |  |
| lifecycle/rollback | ts | 281.6 | 78.625 | 68.275 | 102023 | 770.7 | 39.9 KiB | 14.5 KiB |  |
| macro/game-tick | ts | 220.1 | 9.617 | 5.883 | 67042 | 143.5 | 78.4 KiB | 5.1 KiB |  |
| macro/game-tick | zig | 14.2 | 1.355 | 1.339 | 67042 | 20.2 | 78.4 KiB |  |  |
| macro/game-tick | applescript |  | 1.519 | 1.504 |  |  |  |  |  |
| macro/game-tick | gopher-lua |  | 0.141 | 0.140 |  |  |  | 28.7 KiB | 128 |
| macro/report | ts | 129.4 | 2.217 | 2.041 | 86555 | 25.6 | 1.2 MiB | 2.3 MiB |  |
| macro/report | zig | 8.4 | 1.293 | 1.288 | 86555 | 14.9 | 1.2 MiB |  |  |
| macro/report | applescript |  | 3.347 | 3.306 |  |  |  |  |  |
| macro/report | gopher-lua |  | 0.143 | 0.138 |  |  |  | 33.1 KiB | 1291 |
| macro/transform | ts | 180.2 | 3.446 | 3.130 | 20664 | 166.8 | 6.1 MiB | 4.1 KiB |  |
| macro/transform | zig | 12.1 | 0.297 | 0.294 | 20664 | 14.3 | 6.1 MiB |  |  |
| macro/transform | applescript |  | 0.414 | 0.387 |  |  |  |  |  |
| macro/transform | gopher-lua |  | 0.136 | 0.135 |  |  |  | 268.0 KiB | 4538 |
| messaging/joins | ts | 252.5 | 21.556 | 20.496 | 127218 | 169.4 | 239.1 KiB | 3.2 KiB |  |
| messaging/parents | ts | 163.8 | 16.671 | 15.521 | 67518 | 246.9 | 93.8 KiB | 580.6 KiB |  |
| messaging/sends | ts | 182.7 | 18.037 | 16.970 | 67518 | 267.1 | 93.8 KiB | 221.5 KiB |  |
| messaging/suspend | ts | 108.3 | 18.419 | 17.372 | 48018 | 383.6 | 31.3 KiB | 8.4 KiB |  |
| messaging/suspend | zig | 7.0 | 3.072 | 2.994 | 48018 | 64.0 | 31.3 KiB |  |  |
| numbers/add | ts | 123.1 | 2.395 | 2.182 | 26030 | 92.0 | 31.4 KiB | 293.8 KiB |  |
| numbers/add | zig | 8.2 | 0.506 | 0.503 | 26030 | 19.5 | 31.4 KiB |  |  |
| numbers/add | applescript |  | 0.246 | 0.244 |  |  |  |  |  |
| numbers/add | gopher-lua |  | 0.0288 | 0.0287 |  |  |  | 43.9 KiB | 177 |
| numbers/divide | ts | 94.1 | 2.136 | 1.953 | 18031 | 118.5 | 31.4 KiB | 502.4 KiB |  |
| numbers/divide | zig | 7.8 | 0.371 | 0.366 | 18031 | 20.6 | 31.4 KiB |  |  |
| numbers/divide | applescript |  | 0.204 | 0.203 |  |  |  |  |  |
| numbers/divide | gopher-lua |  | 0.0221 | 0.0218 |  |  |  | 28.3 KiB | 115 |
| numbers/multiply | ts | 98.5 | 1.496 | 1.328 | 18031 | 83.0 | 31.4 KiB | 227.5 KiB |  |
| numbers/multiply | zig | 8.2 | 0.324 | 0.320 | 18031 | 18.0 | 31.4 KiB |  |  |
| numbers/multiply | applescript |  | 0.188 | 0.185 |  |  |  |  |  |
| numbers/multiply | gopher-lua |  | 0.0202 | 0.0200 |  |  |  | 29.1 KiB | 118 |
| numbers/quantity | ts | 161.9 | 4.301 | 3.992 | 14579 | 295.0 | 39.1 KiB | 202.1 KiB |  |
| numbers/quantity | zig | 9.5 | 0.311 | 0.311 | 14579 | 21.3 | 39.1 KiB |  |  |
| numbers/quantity | applescript |  | 0.124 | 0.123 |  |  |  |  |  |
| numbers/quantity | gopher-lua |  | 0.0127 | 0.0126 |  |  |  | 16.5 KiB | 67 |
| text/build | ts | 106.5 | 1.134 | 1.035 | 28928 | 39.2 | 374.8 KiB | 165.3 KiB |  |
| text/build | zig | 6.5 | 0.455 | 0.451 | 28928 | 15.7 | 374.8 KiB |  |  |
| text/build | applescript |  | 0.424 | 0.380 |  |  |  |  |  |
| text/build | gopher-lua |  | 0.0739 | 0.0716 |  |  |  | 400.8 KiB | 1024 |
| text/graphemes | ts | 150.9 | 5.851 | 5.498 | 43518 | 134.4 | 144.1 KiB | 343.0 KiB |  |
| text/graphemes | zig | 8.4 | 1.128 | 1.114 | 43518 | 25.9 | 144.1 KiB |  |  |
| text/index | ts | 137.6 | 4.257 | 3.976 | 26640 | 159.8 | 49.9 KiB | 597.6 KiB |  |
| text/index | zig | 8.9 | 0.680 | 0.674 | 26640 | 25.5 | 49.9 KiB |  |  |
| text/index | applescript |  | 0.935 | 0.930 |  |  |  |  |  |
| text/index | gopher-lua |  | 0.124 | 0.123 |  |  |  | 29.3 KiB | 1055 |
| text/iterate | ts | 116.8 | 3.552 | 3.317 | 30318 | 117.2 | 93.0 KiB | 996.3 KiB |  |
| text/iterate | zig | 8.0 | 0.567 | 0.564 | 30318 | 18.7 | 93.0 KiB |  |  |
| text/iterate | applescript |  | 3.604 | 3.565 |  |  |  |  |  |
| text/iterate | gopher-lua |  | 0.184 | 0.184 |  |  |  | 187.3 KiB | 9847 |
| text/patterns | ts | 135.7 | 6.341 | 5.817 | 13818 | 458.9 | 225.9 KiB | 1.8 MiB |  |
| text/patterns | zig | 8.2 | 0.616 | 0.615 | 13818 | 44.6 | 225.9 KiB |  |  |
| text/patterns | applescript |  | 16.452 | 16.345 |  |  |  |  |  |
| text/patterns | gopher-lua |  | 0.276 | 0.271 |  |  |  | 390.8 KiB | 17736 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- core/fib@slice=10 on zig: 112.5 ns/Fuel, 5.6× the median
- collections/map-build on zig: 70.4 ns/Fuel, 3.5× the median
- host/pump on zig: 256.2 ns/Fuel, 12.7× the median
- messaging/suspend on zig: 64.0 ns/Fuel, 3.2× the median
- lifecycle/load-small on zig: 254.4 ns/Fuel, 12.6× the median
- text/patterns on ts: 458.9 ns/Fuel, 3.2× the median
- host/pump on ts: 1127.2 ns/Fuel, 8.0× the median
- lifecycle/load-small on ts: 1093.8 ns/Fuel, 7.7× the median
- lifecycle/rollback on ts: 770.7 ns/Fuel, 5.4× the median

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
