# Benchmark results, 2026-10-14

Commit `f51ad856-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 3, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | ts | 273.0 | 8.255 | 7.575 | 89459 | 92.3 | 195.6 KiB | 1.5 MiB |  |
| collections/iterate | zig | 13.4 | 1.422 | 1.420 | 89459 | 15.9 | 195.6 KiB |  |  |
| collections/iterate | applescript |  | 8.361 | 7.983 |  |  |  |  |  |
| collections/iterate | gopher-lua |  | 0.625 | 0.619 |  |  |  | 108.9 KiB | 6741 |
| collections/list-append | ts | 213.7 | 10.056 | 6.326 | 52056 | 193.2 | 78.3 KiB | 1.0 MiB |  |
| collections/list-append | zig | 9.9 | 0.915 | 0.913 | 52056 | 17.6 | 78.3 KiB |  |  |
| collections/list-append | applescript |  | 2.005 | 1.831 |  |  |  |  |  |
| collections/list-append | gopher-lua |  | 0.413 | 0.387 |  |  |  | 203.9 KiB | 4315 |
| collections/list-build | ts | 152.0 | 1.661 | 1.420 | 19091 | 87.0 | 2.9 MiB | 223.0 KiB |  |
| collections/list-build | zig | 7.7 | 0.206 | 0.205 | 19091 | 10.8 | 2.9 MiB |  |  |
| collections/list-build | applescript |  | 0.299 | 0.288 |  |  |  |  |  |
| collections/list-build | gopher-lua |  | 0.0877 | 0.0861 |  |  |  | 35.4 KiB | 1045 |
| collections/list-update | ts | 226.9 | 5.310 | 3.423 | 28553 | 186.0 | 23.8 KiB | 548.4 KiB |  |
| collections/list-update | zig | 11.1 | 0.514 | 0.513 | 28553 | 18.0 | 23.8 KiB |  |  |
| collections/list-update | applescript |  | 0.488 | 0.486 |  |  |  |  |  |
| collections/list-update | gopher-lua |  | 0.0607 | 0.0603 |  |  |  | 22.4 KiB | 106 |
| collections/map-build | ts | 176.5 | 1.530 | 1.431 | 14094 | 108.6 | 24.3 KiB | 194.9 KiB |  |
| collections/map-build | zig | 9.0 | 0.916 | 0.912 | 14094 | 65.0 | 24.3 KiB |  |  |
| collections/map-build | applescript |  | 7.650 | 7.630 |  |  |  |  |  |
| collections/map-build | gopher-lua |  | 0.164 | 0.153 |  |  |  | 90.5 KiB | 1291 |
| collections/map-update | ts | 208.5 | 1.633 | 1.015 | 8056 | 202.7 | 12.1 KiB | 150.1 KiB |  |
| collections/map-update | zig | 11.2 | 0.207 | 0.205 | 8056 | 25.7 | 12.1 KiB |  |  |
| collections/map-update | applescript |  | 4.760 | 4.592 |  |  |  |  |  |
| collections/map-update | gopher-lua |  | 0.0380 | 0.0375 |  |  |  | 10.2 KiB | 76 |
| core/calls | ts | 134.6 | 2.992 | 2.742 | 46018 | 65.0 | 31.3 KiB | 153.9 KiB |  |
| core/calls | zig | 7.8 | 0.633 | 0.631 | 46018 | 13.8 | 31.3 KiB |  |  |
| core/calls | applescript |  | 0.756 | 0.734 |  |  |  |  |  |
| core/calls | gopher-lua |  | 0.173 | 0.160 |  |  |  | 44.8 KiB | 180 |
| core/fib | ts | 105.0 | 2.372 | 1.967 | 46365 | 51.2 | 46.2 KiB | 256.8 KiB |  |
| core/fib | zig | 7.2 | 0.702 | 0.688 | 46365 | 15.1 | 46.2 KiB |  |  |
| core/fib | applescript |  | 0.540 | 0.539 |  |  |  |  |  |
| core/fib | gopher-lua |  | 0.0931 | 0.0921 |  |  |  | 63 B | 1 |
| core/fib@slice=10 | ts | 83.3 | 10.690 | 9.482 | 46365 | 230.6 | 46.2 KiB | 686.4 KiB |  |
| core/fib@slice=10 | zig | 7.3 | 4.871 | 4.672 | 46365 | 105.0 | 46.2 KiB |  |  |
| core/fib@slice=100 | ts | 77.3 | 2.979 | 2.783 | 46365 | 64.3 | 46.2 KiB | 4.9 KiB |  |
| core/fib@slice=100 | zig | 7.2 | 1.120 | 1.109 | 46365 | 24.2 | 46.2 KiB |  |  |
| core/fib@slice=1000 | ts | 75.5 | 2.230 | 2.085 | 46365 | 48.1 | 46.2 KiB | 24.7 KiB |  |
| core/fib@slice=1000 | zig | 7.6 | 0.740 | 0.737 | 46365 | 16.0 | 46.2 KiB |  |  |
| core/fib@slice=10000 | ts | 74.9 | 2.160 | 2.017 | 46365 | 46.6 | 46.2 KiB | 12.8 KiB |  |
| core/fib@slice=10000 | zig | 7.2 | 0.697 | 0.694 | 46365 | 15.0 | 46.2 KiB |  |  |
| core/lambdas | ts | 172.3 | 4.506 | 3.906 | 58027 | 77.6 | 62.6 KiB | 500.6 KiB |  |
| core/lambdas | zig | 8.9 | 0.847 | 0.846 | 58027 | 14.6 | 62.6 KiB |  |  |
| core/lambdas | applescript |  | 0.822 | 0.786 |  |  |  |  |  |
| core/lambdas | gopher-lua |  | 0.212 | 0.209 |  |  |  | 60.3 KiB | 244 |
| core/loop | ts | 102.8 | 2.884 | 2.659 | 48016 | 60.1 | 62.5 KiB | 333.3 KiB |  |
| core/loop | zig | 6.8 | 0.942 | 0.937 | 48016 | 19.6 | 62.5 KiB |  |  |
| core/loop | applescript |  | 0.207 | 0.207 |  |  |  |  |  |
| core/loop | gopher-lua |  | 0.0607 | 0.0602 |  |  |  | 44.8 KiB | 180 |
| host/conversion | ts | 225.3 | 11.564 | 10.254 | 25018 | 462.2 | 220.3 KiB | 631.4 KiB |  |
| host/immediate | ts | 135.3 | 2.465 | 2.292 | 13518 | 182.3 | 15.7 KiB | 120.6 KiB |  |
| host/properties | ts | 125.3 | 1.880 | 1.755 | 9018 | 208.5 | 15.7 KiB | 221.8 KiB |  |
| host/pump | ts | 27.8 | 0.00989 | 0.00844 | 7 | 1412.7 | 0 B | 3.7 KiB |  |
| host/pump | zig | 2.4 | 0.00180 | 0.00167 | 7 | 257.2 | 0 B |  |  |
| host/suspending | ts | 143.0 | 5.466 | 4.762 | 13518 | 404.3 | 15.7 KiB | 867.7 KiB |  |
| lifecycle/load-large | ts | 17620.8 | 0.698 | 0.639 | 4609 | 151.4 | 16.3 KiB | 188 B |  |
| lifecycle/load-large | zig | 767.2 | 0.150 | 0.150 | 4609 | 32.5 | 16.3 KiB |  |  |
| lifecycle/load-small | ts | 35.8 | 0.00791 | 0.00721 | 7 | 1130.0 | 0 B | 920 B |  |
| lifecycle/load-small | zig | 3.1 | 0.00182 | 0.00166 | 7 | 260.4 | 0 B |  |  |
| lifecycle/restore | ts | 251.3 | 7.123 | 6.643 | 8015 | 888.7 | 7.8 KiB | 41.9 KiB |  |
| lifecycle/rollback | ts | 263.8 | 75.832 | 67.454 | 102023 | 743.3 | 39.9 KiB | 4.4 KiB |  |
| macro/game-tick | ts | 238.7 | 10.382 | 9.967 | 67042 | 154.9 | 78.4 KiB | 4.4 KiB |  |
| macro/game-tick | zig | 13.7 | 1.294 | 1.292 | 67042 | 19.3 | 78.4 KiB |  |  |
| macro/game-tick | applescript |  | 1.799 | 1.752 |  |  |  |  |  |
| macro/game-tick | gopher-lua |  | 0.197 | 0.184 |  |  |  | 28.7 KiB | 128 |
| macro/report | ts | 138.2 | 2.430 | 2.300 | 86555 | 28.1 | 1.2 MiB | 2.4 MiB |  |
| macro/report | zig | 7.7 | 1.202 | 1.202 | 86555 | 13.9 | 1.2 MiB |  |  |
| macro/report | applescript |  | 4.189 | 4.167 |  |  |  |  |  |
| macro/report | gopher-lua |  | 0.188 | 0.186 |  |  |  | 33.1 KiB | 1291 |
| macro/transform | ts | 188.5 | 3.542 | 3.321 | 20664 | 171.4 | 6.1 MiB | 138.7 KiB |  |
| macro/transform | zig | 10.9 | 0.283 | 0.281 | 20664 | 13.7 | 6.1 MiB |  |  |
| macro/transform | applescript |  | 0.465 | 0.443 |  |  |  |  |  |
| macro/transform | gopher-lua |  | 0.250 | 0.249 |  |  |  | 268.0 KiB | 4538 |
| messaging/joins | ts | 270.7 | 24.664 | 23.401 | 127218 | 193.9 | 239.1 KiB | 72.9 KiB |  |
| messaging/parents | ts | 174.7 | 20.306 | 16.264 | 67518 | 300.8 | 93.8 KiB | 58.1 KiB |  |
| messaging/sends | ts | 196.5 | 26.608 | 22.568 | 67518 | 394.1 | 93.8 KiB | 257.2 KiB |  |
| messaging/suspend | ts | 111.8 | 18.332 | 17.695 | 48018 | 381.8 | 31.3 KiB | 2.3 MiB |  |
| messaging/suspend | zig | 6.5 | 2.958 | 2.904 | 48018 | 61.6 | 31.3 KiB |  |  |
| numbers/add | ts | 109.0 | 2.775 | 2.503 | 26030 | 106.6 | 31.4 KiB | 293.1 KiB |  |
| numbers/add | zig | 7.2 | 0.462 | 0.459 | 26030 | 17.7 | 31.4 KiB |  |  |
| numbers/add | applescript |  | 0.304 | 0.286 |  |  |  |  |  |
| numbers/add | gopher-lua |  | 0.0626 | 0.0624 |  |  |  | 43.9 KiB | 177 |
| numbers/divide | ts | 111.0 | 2.394 | 2.222 | 18031 | 132.8 | 31.4 KiB | 680.4 KiB |  |
| numbers/divide | zig | 6.9 | 0.333 | 0.333 | 18031 | 18.5 | 31.4 KiB |  |  |
| numbers/divide | applescript |  | 0.245 | 0.244 |  |  |  |  |  |
| numbers/divide | gopher-lua |  | 0.0449 | 0.0449 |  |  |  | 28.3 KiB | 115 |
| numbers/multiply | ts | 110.2 | 1.747 | 1.614 | 18031 | 96.9 | 31.4 KiB | 231.5 KiB |  |
| numbers/multiply | zig | 6.9 | 0.299 | 0.298 | 18031 | 16.6 | 31.4 KiB |  |  |
| numbers/multiply | applescript |  | 0.227 | 0.226 |  |  |  |  |  |
| numbers/multiply | gopher-lua |  | 0.0437 | 0.0433 |  |  |  | 29.1 KiB | 118 |
| numbers/quantity | ts | 173.1 | 4.631 | 4.276 | 14579 | 317.7 | 39.1 KiB | 178.1 KiB |  |
| numbers/quantity | zig | 8.5 | 0.374 | 0.374 | 14579 | 25.7 | 39.1 KiB |  |  |
| numbers/quantity | applescript |  | 0.155 | 0.146 |  |  |  |  |  |
| numbers/quantity | gopher-lua |  | 0.0276 | 0.0273 |  |  |  | 16.5 KiB | 67 |
| text/build | ts | 109.0 | 1.236 | 1.160 | 28928 | 42.7 | 374.8 KiB | 129.9 KiB |  |
| text/build | zig | 5.8 | 0.424 | 0.423 | 28928 | 14.7 | 374.8 KiB |  |  |
| text/build | applescript |  | 0.456 | 0.455 |  |  |  |  |  |
| text/build | gopher-lua |  | 0.107 | 0.105 |  |  |  | 400.8 KiB | 1024 |
| text/graphemes | ts | 135.4 | 6.961 | 6.239 | 43518 | 160.0 | 144.1 KiB | 962.3 KiB |  |
| text/graphemes | zig | 7.6 | 1.064 | 1.060 | 43518 | 24.4 | 144.1 KiB |  |  |
| text/index | ts | 149.3 | 8.943 | 7.121 | 26640 | 335.7 | 49.9 KiB | 798.2 KiB |  |
| text/index | zig | 8.5 | 0.642 | 0.641 | 26640 | 24.1 | 49.9 KiB |  |  |
| text/index | applescript |  | 1.199 | 1.107 |  |  |  |  |  |
| text/index | gopher-lua |  | 0.156 | 0.133 |  |  |  | 29.3 KiB | 1055 |
| text/iterate | ts | 127.4 | 4.297 | 4.026 | 30318 | 141.7 | 93.0 KiB | 1.2 MiB |  |
| text/iterate | zig | 7.3 | 0.545 | 0.543 | 30318 | 18.0 | 93.0 KiB |  |  |
| text/iterate | applescript |  | 4.413 | 4.316 |  |  |  |  |  |
| text/iterate | gopher-lua |  | 0.216 | 0.207 |  |  |  | 187.3 KiB | 9847 |
| text/patterns | ts | 139.0 | 7.296 | 6.361 | 13818 | 528.0 | 225.9 KiB | 1.5 MiB |  |
| text/patterns | zig | 7.5 | 0.585 | 0.584 | 13818 | 42.3 | 225.9 KiB |  |  |
| text/patterns | applescript |  | 20.955 | 20.295 |  |  |  |  |  |
| text/patterns | gopher-lua |  | 0.579 | 0.562 |  |  |  | 390.8 KiB | 17736 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- core/fib@slice=10 on zig: 105.0 ns/Fuel, 5.8× the median
- collections/map-build on zig: 65.0 ns/Fuel, 3.6× the median
- host/pump on zig: 257.2 ns/Fuel, 14.1× the median
- messaging/suspend on zig: 61.6 ns/Fuel, 3.4× the median
- lifecycle/load-small on zig: 260.4 ns/Fuel, 14.3× the median
- text/patterns on ts: 528.0 ns/Fuel, 3.2× the median
- host/pump on ts: 1412.7 ns/Fuel, 8.5× the median
- lifecycle/load-small on ts: 1130.0 ns/Fuel, 6.8× the median
- lifecycle/rollback on ts: 743.3 ns/Fuel, 4.5× the median

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
