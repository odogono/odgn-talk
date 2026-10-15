# Benchmark results, 2026-10-15

Commit `f51ad856-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 3, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | ts | 283.0 | 22.762 | 14.821 | 89459 | 254.4 | 195.6 KiB | 753.5 KiB |  |
| collections/iterate | zig | 20.7 | 2.081 | 2.018 | 89459 | 23.3 | 195.6 KiB |  |  |
| collections/iterate | applescript |  | 7.398 | 6.782 |  |  |  |  |  |
| collections/iterate | gopher-lua |  | 0.811 | 0.732 |  |  |  | 108.9 KiB | 6741 |
| collections/list-append | ts | 222.3 | 11.088 | 6.573 | 52056 | 213.0 | 78.3 KiB | 750.5 KiB |  |
| collections/list-append | zig | 11.4 | 1.183 | 1.168 | 52056 | 22.7 | 78.3 KiB |  |  |
| collections/list-append | applescript |  | 1.698 | 1.657 |  |  |  |  |  |
| collections/list-append | gopher-lua |  | 0.519 | 0.490 |  |  |  | 203.9 KiB | 4315 |
| collections/list-build | ts | 119.8 | 1.924 | 1.477 | 19091 | 100.8 | 2.9 MiB | 104.3 KiB |  |
| collections/list-build | zig | 8.7 | 0.262 | 0.261 | 19091 | 13.7 | 2.9 MiB |  |  |
| collections/list-build | applescript |  | 0.276 | 0.274 |  |  |  |  |  |
| collections/list-build | gopher-lua |  | 0.103 | 0.103 |  |  |  | 35.4 KiB | 1045 |
| collections/list-update | ts | 229.0 | 5.904 | 3.542 | 28553 | 206.8 | 23.8 KiB | 773.3 KiB |  |
| collections/list-update | zig | 11.5 | 0.732 | 0.709 | 28553 | 25.6 | 23.8 KiB |  |  |
| collections/list-update | applescript |  | 0.462 | 0.428 |  |  |  |  |  |
| collections/list-update | gopher-lua |  | 0.0785 | 0.0760 |  |  |  | 22.4 KiB | 106 |
| collections/map-build | ts | 178.5 | 1.626 | 1.459 | 14094 | 115.4 | 24.3 KiB | 287.0 KiB |  |
| collections/map-build | zig | 10.5 | 1.314 | 1.160 | 14094 | 93.2 | 24.3 KiB |  |  |
| collections/map-build | applescript |  | 6.990 | 6.625 |  |  |  |  |  |
| collections/map-build | gopher-lua |  | 0.219 | 0.208 |  |  |  | 90.5 KiB | 1291 |
| collections/map-update | ts | 227.8 | 1.254 | 1.128 | 8056 | 155.6 | 12.1 KiB | 95.4 KiB |  |
| collections/map-update | zig | 19.9 | 0.284 | 0.253 | 8056 | 35.2 | 12.1 KiB |  |  |
| collections/map-update | applescript |  | 4.504 | 4.339 |  |  |  |  |  |
| collections/map-update | gopher-lua |  | 0.0473 | 0.0467 |  |  |  | 10.2 KiB | 76 |
| core/calls | ts | 167.9 | 3.519 | 3.058 | 46018 | 76.5 | 31.3 KiB | 24.9 KiB |  |
| core/calls | zig | 8.7 | 0.783 | 0.781 | 46018 | 17.0 | 31.3 KiB |  |  |
| core/calls | applescript |  | 0.705 | 0.696 |  |  |  |  |  |
| core/calls | gopher-lua |  | 0.0890 | 0.0877 |  |  |  | 44.8 KiB | 180 |
| core/fib | ts | 139.1 | 3.055 | 2.504 | 46365 | 65.9 | 46.2 KiB | 311.9 KiB |  |
| core/fib | zig | 8.0 | 0.823 | 0.820 | 46365 | 17.7 | 46.2 KiB |  |  |
| core/fib | applescript |  | 0.603 | 0.566 |  |  |  |  |  |
| core/fib | gopher-lua |  | 0.0893 | 0.0863 |  |  |  | 63 B | 1 |
| core/fib@slice=10 | ts | 112.0 | 16.778 | 11.635 | 46365 | 361.9 | 46.2 KiB | 1.3 MiB |  |
| core/fib@slice=10 | zig | 7.9 | 5.573 | 5.500 | 46365 | 120.2 | 46.2 KiB |  |  |
| core/fib@slice=100 | ts | 99.8 | 4.202 | 3.465 | 46365 | 90.6 | 46.2 KiB | 75.2 KiB |  |
| core/fib@slice=100 | zig | 7.9 | 1.311 | 1.308 | 46365 | 28.3 | 46.2 KiB |  |  |
| core/fib@slice=1000 | ts | 102.7 | 2.976 | 2.706 | 46365 | 64.2 | 46.2 KiB | 9.1 KiB |  |
| core/fib@slice=1000 | zig | 8.0 | 0.870 | 0.868 | 46365 | 18.8 | 46.2 KiB |  |  |
| core/fib@slice=10000 | ts | 94.5 | 2.783 | 2.492 | 46365 | 60.0 | 46.2 KiB | 30.8 KiB |  |
| core/fib@slice=10000 | zig | 8.0 | 0.839 | 0.839 | 46365 | 18.1 | 46.2 KiB |  |  |
| core/lambdas | ts | 211.6 | 6.246 | 4.443 | 58027 | 107.6 | 62.6 KiB | 357.7 KiB |  |
| core/lambdas | zig | 9.9 | 1.050 | 1.050 | 58027 | 18.1 | 62.6 KiB |  |  |
| core/lambdas | applescript |  | 0.812 | 0.734 |  |  |  |  |  |
| core/lambdas | gopher-lua |  | 0.108 | 0.104 |  |  |  | 60.3 KiB | 244 |
| core/loop | ts | 139.0 | 3.953 | 3.204 | 48016 | 82.3 | 62.5 KiB | 368.8 KiB |  |
| core/loop | zig | 8.1 | 1.156 | 1.152 | 48016 | 24.1 | 62.5 KiB |  |  |
| core/loop | applescript |  | 0.212 | 0.206 |  |  |  |  |  |
| core/loop | gopher-lua |  | 0.0560 | 0.0552 |  |  |  | 44.8 KiB | 180 |
| host/conversion | ts | 202.4 | 12.673 | 9.137 | 25018 | 506.5 | 220.3 KiB | 2.4 MiB |  |
| host/immediate | ts | 155.1 | 3.902 | 3.064 | 13518 | 288.6 | 15.7 KiB | 48.0 KiB |  |
| host/properties | ts | 127.9 | 1.979 | 1.556 | 9018 | 219.4 | 15.7 KiB | 167.4 KiB |  |
| host/pump | ts | 38.3 | 0.00984 | 0.00938 | 7 | 1405.7 | 0 B | 4.2 KiB |  |
| host/pump | zig | 3.1 | 0.00222 | 0.00220 | 7 | 317.6 | 0 B |  |  |
| host/suspending | ts | 192.0 | 6.633 | 4.972 | 13518 | 490.7 | 15.7 KiB | 404.8 KiB |  |
| lifecycle/load-large | ts | 19688.7 | 1.085 | 0.897 | 4609 | 235.4 | 16.3 KiB | 137 B |  |
| lifecycle/load-large | zig | 963.4 | 0.193 | 0.186 | 4609 | 41.8 | 16.3 KiB |  |  |
| lifecycle/load-small | ts | 38.0 | 0.0116 | 0.0102 | 7 | 1653.3 | 0 B | 759 B |  |
| lifecycle/load-small | zig | 3.7 | 0.00186 | 0.00186 | 7 | 265.6 | 0 B |  |  |
| lifecycle/restore | ts | 277.2 | 9.421 | 8.411 | 8015 | 1175.4 | 7.8 KiB | 151.8 KiB |  |
| lifecycle/rollback | ts | 289.0 | 57.504 | 54.630 | 102023 | 563.6 | 39.9 KiB | 12.8 KiB |  |
| macro/game-tick | ts | 241.8 | 7.232 | 6.451 | 67042 | 107.9 | 78.4 KiB | 43.4 KiB |  |
| macro/game-tick | zig | 18.5 | 1.557 | 1.549 | 67042 | 23.2 | 78.4 KiB |  |  |
| macro/game-tick | applescript |  | 1.570 | 1.537 |  |  |  |  |  |
| macro/game-tick | gopher-lua |  | 0.232 | 0.222 |  |  |  | 28.7 KiB | 128 |
| macro/report | ts | 141.5 | 2.194 | 1.942 | 86555 | 25.3 | 1.2 MiB | 2.4 MiB |  |
| macro/report | zig | 10.5 | 1.551 | 1.370 | 86555 | 17.9 | 1.2 MiB |  |  |
| macro/report | applescript |  | 3.593 | 3.556 |  |  |  |  |  |
| macro/report | gopher-lua |  | 0.221 | 0.215 |  |  |  | 33.1 KiB | 1291 |
| macro/transform | ts | 198.0 | 2.677 | 2.337 | 20664 | 129.6 | 6.1 MiB | 12.5 KiB |  |
| macro/transform | zig | 12.8 | 0.361 | 0.349 | 20664 | 17.5 | 6.1 MiB |  |  |
| macro/transform | applescript |  | 0.389 | 0.382 |  |  |  |  |  |
| macro/transform | gopher-lua |  | 0.401 | 0.361 |  |  |  | 268.0 KiB | 4538 |
| messaging/joins | ts | 272.8 | 43.985 | 36.618 | 127218 | 345.7 | 239.1 KiB | 10.4 KiB |  |
| messaging/parents | ts | 172.9 | 29.385 | 23.968 | 67518 | 435.2 | 93.8 KiB | 2.8 KiB |  |
| messaging/sends | ts | 198.8 | 32.816 | 20.417 | 67518 | 486.0 | 93.8 KiB | 197.3 KiB |  |
| messaging/suspend | ts | 120.3 | 28.506 | 24.083 | 48018 | 593.7 | 31.3 KiB | 683 B |  |
| messaging/suspend | zig | 7.5 | 3.942 | 3.682 | 48018 | 82.1 | 31.3 KiB |  |  |
| numbers/add | ts | 155.0 | 3.640 | 2.771 | 26030 | 139.9 | 31.4 KiB | 204.6 KiB |  |
| numbers/add | zig | 7.4 | 0.557 | 0.556 | 26030 | 21.4 | 31.4 KiB |  |  |
| numbers/add | applescript |  | 0.284 | 0.278 |  |  |  |  |  |
| numbers/add | gopher-lua |  | 0.0332 | 0.0329 |  |  |  | 43.9 KiB | 177 |
| numbers/divide | ts | 117.6 | 2.584 | 2.392 | 18031 | 143.3 | 31.4 KiB | 807.5 KiB |  |
| numbers/divide | zig | 7.8 | 0.505 | 0.460 | 18031 | 28.0 | 31.4 KiB |  |  |
| numbers/divide | applescript |  | 0.235 | 0.233 |  |  |  |  |  |
| numbers/divide | gopher-lua |  | 0.0430 | 0.0365 |  |  |  | 28.3 KiB | 115 |
| numbers/multiply | ts | 116.8 | 2.245 | 1.746 | 18031 | 124.5 | 31.4 KiB | 248.7 KiB |  |
| numbers/multiply | zig | 9.7 | 0.370 | 0.369 | 18031 | 20.5 | 31.4 KiB |  |  |
| numbers/multiply | applescript |  | 0.211 | 0.204 |  |  |  |  |  |
| numbers/multiply | gopher-lua |  | 0.0324 | 0.0259 |  |  |  | 29.1 KiB | 118 |
| numbers/quantity | ts | 146.4 | 3.710 | 3.023 | 14579 | 254.4 | 39.1 KiB | 585.9 KiB |  |
| numbers/quantity | zig | 9.3 | 0.443 | 0.443 | 14579 | 30.4 | 39.1 KiB |  |  |
| numbers/quantity | applescript |  | 0.147 | 0.146 |  |  |  |  |  |
| numbers/quantity | gopher-lua |  | 0.0258 | 0.0239 |  |  |  | 16.5 KiB | 67 |
| text/build | ts | 94.6 | 1.269 | 1.061 | 28928 | 43.9 | 374.8 KiB | 125.7 KiB |  |
| text/build | zig | 6.5 | 0.480 | 0.476 | 28928 | 16.6 | 374.8 KiB |  |  |
| text/build | applescript |  | 0.427 | 0.404 |  |  |  |  |  |
| text/build | gopher-lua |  | 0.111 | 0.108 |  |  |  | 400.8 KiB | 1024 |
| text/graphemes | ts | 139.0 | 9.991 | 6.661 | 43518 | 229.6 | 144.1 KiB | 609.9 KiB |  |
| text/graphemes | zig | 9.4 | 1.347 | 1.306 | 43518 | 30.9 | 144.1 KiB |  |  |
| text/index | ts | 143.5 | 8.794 | 6.838 | 26640 | 330.1 | 49.9 KiB | 1.3 MiB |  |
| text/index | zig | 9.3 | 0.775 | 0.763 | 26640 | 29.1 | 49.9 KiB |  |  |
| text/index | applescript |  | 1.054 | 1.002 |  |  |  |  |  |
| text/index | gopher-lua |  | 0.175 | 0.149 |  |  |  | 29.3 KiB | 1055 |
| text/iterate | ts | 115.0 | 4.091 | 3.367 | 30318 | 135.0 | 93.0 KiB | 254.0 KiB |  |
| text/iterate | zig | 7.9 | 0.653 | 0.651 | 30318 | 21.5 | 93.0 KiB |  |  |
| text/iterate | applescript |  | 3.858 | 3.821 |  |  |  |  |  |
| text/iterate | gopher-lua |  | 0.285 | 0.285 |  |  |  | 187.3 KiB | 9847 |
| text/patterns | ts | 147.2 | 10.656 | 6.443 | 13818 | 771.2 | 225.9 KiB | 1.7 MiB |  |
| text/patterns | zig | 8.3 | 0.700 | 0.669 | 13818 | 50.7 | 225.9 KiB |  |  |
| text/patterns | applescript |  | 19.151 | 18.652 |  |  |  |  |  |
| text/patterns | gopher-lua |  | 0.730 | 0.707 |  |  |  | 390.8 KiB | 17736 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- core/fib@slice=10 on zig: 120.2 ns/Fuel, 5.1× the median
- collections/map-build on zig: 93.2 ns/Fuel, 3.9× the median
- host/pump on zig: 317.6 ns/Fuel, 13.4× the median
- messaging/suspend on zig: 82.1 ns/Fuel, 3.5× the median
- lifecycle/load-small on zig: 265.6 ns/Fuel, 11.2× the median
- text/patterns on ts: 771.2 ns/Fuel, 3.7× the median
- host/pump on ts: 1405.7 ns/Fuel, 6.7× the median
- lifecycle/load-small on ts: 1653.3 ns/Fuel, 7.9× the median

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
