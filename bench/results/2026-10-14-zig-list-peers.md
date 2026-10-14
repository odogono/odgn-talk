# Benchmark results, 2026-10-14

Commit `8f98a485-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 3, runners ts,zig,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | ts | 240.5 | 6.765 | 6.397 | 89459 | 75.6 | 195.6 KiB | 1.2 MiB |  |
| collections/iterate | zig | 13.4 | 2.126 | 2.123 | 89459 | 23.8 | 195.6 KiB |  |  |
| collections/iterate | applescript |  | 6.146 | 6.084 |  |  |  |  |  |
| collections/iterate | gopher-lua |  | 0.393 | 0.392 |  |  |  | 108.9 KiB | 6741 |
| collections/list-append | ts | 194.4 | 6.956 | 5.442 | 52056 | 133.6 | 78.3 KiB | 1.2 MiB |  |
| collections/list-append | zig | 9.9 | 1.363 | 1.363 | 52056 | 26.2 | 78.3 KiB |  |  |
| collections/list-append | applescript |  | 1.400 | 1.398 |  |  |  |  |  |
| collections/list-append | gopher-lua |  | 0.176 | 0.176 |  |  |  | 203.9 KiB | 4315 |
| collections/list-build | ts | 115.0 | 1.529 | 1.284 | 19091 | 80.1 | 2.9 MiB | 287.8 KiB |  |
| collections/list-build | zig | 7.1 | 0.314 | 0.309 | 19091 | 16.4 | 2.9 MiB |  |  |
| collections/list-build | applescript |  | 0.230 | 0.226 |  |  |  |  |  |
| collections/list-build | gopher-lua |  | 0.0371 | 0.0370 |  |  |  | 35.4 KiB | 1045 |
| collections/list-update | ts | 193.2 | 4.531 | 2.871 | 28553 | 158.7 | 23.8 KiB | 535.5 KiB |  |
| collections/list-update | zig | 10.2 | 0.785 | 0.785 | 28553 | 27.5 | 23.8 KiB |  |  |
| collections/list-update | applescript |  | 0.369 | 0.368 |  |  |  |  |  |
| collections/list-update | gopher-lua |  | 0.0258 | 0.0258 |  |  |  | 22.4 KiB | 106 |
| collections/map-build | ts | 149.3 | 1.325 | 1.229 | 14094 | 94.0 | 24.3 KiB | 216.6 KiB |  |
| collections/map-build | zig | 8.9 | 0.981 | 0.966 | 14094 | 69.6 | 24.3 KiB |  |  |
| collections/map-build | applescript |  | 5.797 | 5.762 |  |  |  |  |  |
| collections/map-build | gopher-lua |  | 0.0791 | 0.0788 |  |  |  | 90.5 KiB | 1291 |
| collections/map-update | ts | 178.1 | 0.959 | 0.896 | 8056 | 119.1 | 12.1 KiB | 126.3 KiB |  |
| collections/map-update | zig | 11.1 | 0.281 | 0.281 | 8056 | 34.9 | 12.1 KiB |  |  |
| collections/map-update | applescript |  | 3.550 | 3.483 |  |  |  |  |  |
| collections/map-update | gopher-lua |  | 0.0190 | 0.0189 |  |  |  | 10.2 KiB | 76 |
| core/calls | ts | 129.0 | 2.656 | 2.446 | 46018 | 57.7 | 31.3 KiB | 78.0 KiB |  |
| core/calls | zig | 7.7 | 0.897 | 0.894 | 46018 | 19.5 | 31.3 KiB |  |  |
| core/calls | applescript |  | 0.598 | 0.596 |  |  |  |  |  |
| core/calls | gopher-lua |  | 0.0806 | 0.0760 |  |  |  | 44.8 KiB | 180 |
| core/fib | ts | 127.3 | 2.322 | 1.933 | 46365 | 50.1 | 46.2 KiB | 200.4 KiB |  |
| core/fib | zig | 7.1 | 0.924 | 0.923 | 46365 | 19.9 | 46.2 KiB |  |  |
| core/fib | applescript |  | 0.484 | 0.472 |  |  |  |  |  |
| core/fib | gopher-lua |  | 0.0721 | 0.0721 |  |  |  | 63 B | 1 |
| core/fib@slice=10 | ts | 93.8 | 10.534 | 9.209 | 46365 | 227.2 | 46.2 KiB | 872.6 KiB |  |
| core/fib@slice=10 | zig | 7.2 | 4.964 | 4.941 | 46365 | 107.1 | 46.2 KiB |  |  |
| core/fib@slice=100 | ts | 80.3 | 2.967 | 2.721 | 46365 | 64.0 | 46.2 KiB | 22.2 KiB |  |
| core/fib@slice=100 | zig | 7.1 | 1.359 | 1.357 | 46365 | 29.3 | 46.2 KiB |  |  |
| core/fib@slice=1000 | ts | 79.8 | 2.248 | 2.055 | 46365 | 48.5 | 46.2 KiB | 3.9 KiB |  |
| core/fib@slice=1000 | zig | 7.2 | 0.989 | 0.988 | 46365 | 21.3 | 46.2 KiB |  |  |
| core/fib@slice=10000 | ts | 79.2 | 2.124 | 1.994 | 46365 | 45.8 | 46.2 KiB | 13.1 KiB |  |
| core/fib@slice=10000 | zig | 7.2 | 0.944 | 0.944 | 46365 | 20.4 | 46.2 KiB |  |  |
| core/lambdas | ts | 159.8 | 3.953 | 3.449 | 58027 | 68.1 | 62.6 KiB | 518.7 KiB |  |
| core/lambdas | zig | 8.8 | 1.213 | 1.209 | 58027 | 20.9 | 62.6 KiB |  |  |
| core/lambdas | applescript |  | 0.650 | 0.650 |  |  |  |  |  |
| core/lambdas | gopher-lua |  | 0.0930 | 0.0881 |  |  |  | 60.3 KiB | 244 |
| core/loop | ts | 98.9 | 2.911 | 2.666 | 48016 | 60.6 | 62.5 KiB | 303.9 KiB |  |
| core/loop | zig | 7.2 | 1.403 | 1.313 | 48016 | 29.2 | 62.5 KiB |  |  |
| core/loop | applescript |  | 0.180 | 0.180 |  |  |  |  |  |
| core/loop | gopher-lua |  | 0.0268 | 0.0261 |  |  |  | 44.8 KiB | 180 |
| host/conversion | ts | 180.9 | 9.405 | 9.109 | 25018 | 375.9 | 220.3 KiB | 1.5 MiB |  |
| host/immediate | ts | 115.5 | 2.158 | 1.997 | 13518 | 159.6 | 15.7 KiB | 529.4 KiB |  |
| host/properties | ts | 108.2 | 2.067 | 1.573 | 9018 | 229.2 | 15.7 KiB | 109.3 KiB |  |
| host/pump | ts | 19.8 | 0.00709 | 0.00642 | 7 | 1013.1 | 0 B | 2.2 KiB |  |
| host/pump | zig | 2.4 | 0.00205 | 0.00203 | 7 | 293.5 | 0 B |  |  |
| host/suspending | ts | 120.3 | 4.843 | 4.195 | 13518 | 358.3 | 15.7 KiB | 225.2 KiB |  |
| lifecycle/load-large | ts | 14042.5 | 0.662 | 0.633 | 4609 | 143.7 | 16.3 KiB | 615 B |  |
| lifecycle/load-large | zig | 780.2 | 0.176 | 0.176 | 4609 | 38.3 | 16.3 KiB |  |  |
| lifecycle/load-small | ts | 29.8 | 0.00706 | 0.00633 | 7 | 1009.0 | 0 B | 4.2 KiB |  |
| lifecycle/load-small | zig | 3.1 | 0.00213 | 0.00213 | 7 | 304.4 | 0 B |  |  |
| lifecycle/restore | ts | 237.5 | 7.200 | 6.769 | 8015 | 898.3 | 7.8 KiB | 64.7 KiB |  |
| lifecycle/rollback | ts | 258.3 | 64.587 | 60.141 | 102023 | 633.1 | 39.9 KiB | 14.7 KiB |  |
| macro/game-tick | ts | 198.0 | 5.718 | 5.527 | 67042 | 85.3 | 78.4 KiB | 6.5 KiB |  |
| macro/game-tick | zig | 12.6 | 1.691 | 1.690 | 67042 | 25.2 | 78.4 KiB |  |  |
| macro/game-tick | applescript |  | 1.364 | 1.350 |  |  |  |  |  |
| macro/game-tick | gopher-lua |  | 0.126 | 0.126 |  |  |  | 28.7 KiB | 128 |
| macro/report | ts | 117.9 | 2.139 | 2.020 | 86555 | 24.7 | 1.2 MiB | 2.3 MiB |  |
| macro/report | zig | 7.5 | 1.280 | 1.264 | 86555 | 14.8 | 1.2 MiB |  |  |
| macro/report | applescript |  | 3.122 | 3.113 |  |  |  |  |  |
| macro/report | gopher-lua |  | 0.127 | 0.127 |  |  |  | 33.1 KiB | 1291 |
| macro/transform | ts | 163.6 | 3.128 | 3.040 | 20664 | 151.4 | 6.1 MiB | 1.6 KiB |  |
| macro/transform | zig | 10.9 | 0.387 | 0.387 | 20664 | 18.7 | 6.1 MiB |  |  |
| macro/transform | applescript |  | 0.334 | 0.333 |  |  |  |  |  |
| macro/transform | gopher-lua |  | 0.123 | 0.123 |  |  |  | 268.0 KiB | 4538 |
| messaging/joins | ts | 229.1 | 20.707 | 18.656 | 127218 | 162.8 | 239.1 KiB | 2.4 KiB |  |
| messaging/parents | ts | 146.5 | 15.183 | 14.608 | 67518 | 224.9 | 93.8 KiB | 115.0 KiB |  |
| messaging/sends | ts | 172.0 | 16.302 | 15.730 | 67518 | 241.4 | 93.8 KiB | 419.1 KiB |  |
| messaging/suspend | ts | 97.5 | 17.107 | 16.132 | 48018 | 356.3 | 31.3 KiB | 344.4 KiB |  |
| messaging/suspend | zig | 6.4 | 3.221 | 3.107 | 48018 | 67.1 | 31.3 KiB |  |  |
| numbers/add | ts | 116.7 | 2.616 | 2.244 | 26030 | 100.5 | 31.4 KiB | 298.5 KiB |  |
| numbers/add | zig | 6.6 | 0.671 | 0.669 | 26030 | 25.8 | 31.4 KiB |  |  |
| numbers/add | applescript |  | 0.233 | 0.232 |  |  |  |  |  |
| numbers/add | gopher-lua |  | 0.0268 | 0.0267 |  |  |  | 43.9 KiB | 177 |
| numbers/divide | ts | 89.7 | 2.171 | 2.050 | 18031 | 120.4 | 31.4 KiB | 451.2 KiB |  |
| numbers/divide | zig | 7.4 | 0.456 | 0.456 | 18031 | 25.3 | 31.4 KiB |  |  |
| numbers/divide | applescript |  | 0.192 | 0.192 |  |  |  |  |  |
| numbers/divide | gopher-lua |  | 0.0201 | 0.0199 |  |  |  | 28.3 KiB | 115 |
| numbers/multiply | ts | 92.7 | 1.545 | 1.403 | 18031 | 85.7 | 31.4 KiB | 258.1 KiB |  |
| numbers/multiply | zig | 6.9 | 0.433 | 0.432 | 18031 | 24.0 | 31.4 KiB |  |  |
| numbers/multiply | applescript |  | 0.175 | 0.174 |  |  |  |  |  |
| numbers/multiply | gopher-lua |  | 0.0186 | 0.0185 |  |  |  | 29.1 KiB | 118 |
| numbers/quantity | ts | 154.1 | 4.099 | 3.878 | 14579 | 281.1 | 39.1 KiB | 562.4 KiB |  |
| numbers/quantity | zig | 8.4 | 0.469 | 0.469 | 14579 | 32.2 | 39.1 KiB |  |  |
| numbers/quantity | applescript |  | 0.119 | 0.118 |  |  |  |  |  |
| numbers/quantity | gopher-lua |  | 0.0114 | 0.0114 |  |  |  | 16.5 KiB | 67 |
| text/build | ts | 95.2 | 1.111 | 1.050 | 28928 | 38.4 | 374.8 KiB | 156.2 KiB |  |
| text/build | zig | 5.8 | 0.468 | 0.468 | 28928 | 16.2 | 374.8 KiB |  |  |
| text/build | applescript |  | 0.366 | 0.364 |  |  |  |  |  |
| text/build | gopher-lua |  | 0.0668 | 0.0655 |  |  |  | 400.8 KiB | 1024 |
| text/graphemes | ts | 110.0 | 5.935 | 5.507 | 43518 | 136.4 | 144.1 KiB | 847.5 KiB |  |
| text/graphemes | zig | 7.5 | 1.343 | 1.342 | 43518 | 30.9 | 144.1 KiB |  |  |
| text/index | ts | 130.3 | 7.092 | 6.312 | 26640 | 266.2 | 49.9 KiB | 1.2 MiB |  |
| text/index | zig | 7.8 | 1.021 | 1.019 | 26640 | 38.3 | 49.9 KiB |  |  |
| text/index | applescript |  | 0.871 | 0.864 |  |  |  |  |  |
| text/index | gopher-lua |  | 0.112 | 0.112 |  |  |  | 29.3 KiB | 1055 |
| text/iterate | ts | 110.9 | 3.688 | 3.462 | 30318 | 121.6 | 93.0 KiB | 1.0 MiB |  |
| text/iterate | zig | 7.1 | 0.727 | 0.726 | 30318 | 24.0 | 93.0 KiB |  |  |
| text/iterate | applescript |  | 3.432 | 3.386 |  |  |  |  |  |
| text/iterate | gopher-lua |  | 0.165 | 0.164 |  |  |  | 187.3 KiB | 9847 |
| text/patterns | ts | 129.6 | 5.954 | 5.612 | 13818 | 430.9 | 225.9 KiB | 1.5 MiB |  |
| text/patterns | zig | 7.4 | 0.633 | 0.632 | 13818 | 45.8 | 225.9 KiB |  |  |
| text/patterns | applescript |  | 15.736 | 15.673 |  |  |  |  |  |
| text/patterns | gopher-lua |  | 0.248 | 0.247 |  |  |  | 390.8 KiB | 17736 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- core/fib@slice=10 on zig: 107.1 ns/Fuel, 4.1× the median
- host/pump on zig: 293.5 ns/Fuel, 11.3× the median
- lifecycle/load-small on zig: 304.4 ns/Fuel, 11.7× the median
- text/patterns on ts: 430.9 ns/Fuel, 3.2× the median
- host/pump on ts: 1013.1 ns/Fuel, 7.5× the median
- lifecycle/load-small on ts: 1009.0 ns/Fuel, 7.5× the median
- lifecycle/rollback on ts: 633.1 ns/Fuel, 4.7× the median

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
