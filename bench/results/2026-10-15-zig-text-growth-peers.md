# Benchmark results, 2026-10-15

Runtime: the #957 working tree on `0aed90d3`. The paired results and this
report’s JSON record runtime source hashes; the commit below is its base.

Commit `0aed90d3-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 3, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | ts | 193.5 | 10.989 | 10.725 | 89459 | 122.8 | 195.6 KiB | 1.2 MiB |  |
| collections/iterate | zig | 13.4 | 1.375 | 1.370 | 89459 | 15.4 | 195.6 KiB |  |  |
| collections/iterate | applescript |  | 5.941 | 5.935 |  |  |  |  |  |
| collections/iterate | gopher-lua |  | 0.459 | 0.439 |  |  |  | 108.9 KiB | 6741 |
| collections/list-append | ts | 190.0 | 4.742 | 4.197 | 52056 | 91.1 | 78.3 KiB | 933.6 KiB |  |
| collections/list-append | zig | 9.9 | 0.853 | 0.852 | 52056 | 16.4 | 78.3 KiB |  |  |
| collections/list-append | applescript |  | 1.400 | 1.386 |  |  |  |  |  |
| collections/list-append | gopher-lua |  | 0.406 | 0.402 |  |  |  | 203.9 KiB | 4315 |
| collections/list-build | ts | 114.6 | 1.004 | 0.948 | 19091 | 52.6 | 2.9 MiB | 329.4 KiB |  |
| collections/list-build | zig | 7.2 | 0.188 | 0.188 | 19091 | 9.8 | 2.9 MiB |  |  |
| collections/list-build | applescript |  | 0.228 | 0.227 |  |  |  |  |  |
| collections/list-build | gopher-lua |  | 0.0868 | 0.0855 |  |  |  | 35.4 KiB | 1045 |
| collections/list-update | ts | 201.5 | 3.885 | 2.221 | 28553 | 136.0 | 23.8 KiB | 423.8 KiB |  |
| collections/list-update | zig | 10.1 | 0.498 | 0.496 | 28553 | 17.4 | 23.8 KiB |  |  |
| collections/list-update | applescript |  | 0.371 | 0.371 |  |  |  |  |  |
| collections/list-update | gopher-lua |  | 0.0633 | 0.0590 |  |  |  | 22.4 KiB | 106 |
| collections/map-build | ts | 147.3 | 1.086 | 1.021 | 14094 | 77.0 | 24.3 KiB | 206.3 KiB |  |
| collections/map-build | zig | 9.0 | 0.875 | 0.852 | 14094 | 62.1 | 24.3 KiB |  |  |
| collections/map-build | applescript |  | 5.752 | 5.729 |  |  |  |  |  |
| collections/map-build | gopher-lua |  | 0.160 | 0.151 |  |  |  | 90.5 KiB | 1291 |
| collections/map-update | ts | 179.7 | 0.773 | 0.712 | 8056 | 96.0 | 12.1 KiB | 134.3 KiB |  |
| collections/map-update | zig | 11.0 | 0.194 | 0.194 | 8056 | 24.1 | 12.1 KiB |  |  |
| collections/map-update | applescript |  | 3.534 | 3.475 |  |  |  |  |  |
| collections/map-update | gopher-lua |  | 0.0395 | 0.0372 |  |  |  | 10.2 KiB | 76 |
| core/calls | ts | 136.8 | 1.909 | 1.787 | 46018 | 41.5 | 31.3 KiB | 170.6 KiB |  |
| core/calls | zig | 7.7 | 0.581 | 0.577 | 46018 | 12.6 | 31.3 KiB |  |  |
| core/calls | applescript |  | 0.600 | 0.599 |  |  |  |  |  |
| core/calls | gopher-lua |  | 0.0709 | 0.0701 |  |  |  | 44.8 KiB | 180 |
| core/fib | ts | 104.5 | 2.195 | 1.773 | 46365 | 47.3 | 46.2 KiB | 232.0 KiB |  |
| core/fib | zig | 7.2 | 0.591 | 0.590 | 46365 | 12.7 | 46.2 KiB |  |  |
| core/fib | applescript |  | 0.484 | 0.473 |  |  |  |  |  |
| core/fib | gopher-lua |  | 0.0740 | 0.0717 |  |  |  | 63 B | 1 |
| core/fib@slice=10 | ts | 85.3 | 10.440 | 9.311 | 46365 | 225.2 | 46.2 KiB | 884.9 KiB |  |
| core/fib@slice=10 | zig | 7.2 | 4.591 | 4.570 | 46365 | 99.0 | 46.2 KiB |  |  |
| core/fib@slice=100 | ts | 78.0 | 2.794 | 2.600 | 46365 | 60.3 | 46.2 KiB | 19.5 KiB |  |
| core/fib@slice=100 | zig | 7.2 | 0.995 | 0.991 | 46365 | 21.5 | 46.2 KiB |  |  |
| core/fib@slice=1000 | ts | 76.7 | 2.051 | 1.935 | 46365 | 44.2 | 46.2 KiB | 35.7 KiB |  |
| core/fib@slice=1000 | zig | 7.2 | 0.634 | 0.632 | 46365 | 13.7 | 46.2 KiB |  |  |
| core/fib@slice=10000 | ts | 77.0 | 1.977 | 1.855 | 46365 | 42.6 | 46.2 KiB | 9.1 KiB |  |
| core/fib@slice=10000 | zig | 7.2 | 0.595 | 0.593 | 46365 | 12.8 | 46.2 KiB |  |  |
| core/lambdas | ts | 165.8 | 2.697 | 2.515 | 58027 | 46.5 | 62.6 KiB | 345.3 KiB |  |
| core/lambdas | zig | 8.9 | 0.755 | 0.754 | 58027 | 13.0 | 62.6 KiB |  |  |
| core/lambdas | applescript |  | 0.646 | 0.644 |  |  |  |  |  |
| core/lambdas | gopher-lua |  | 0.0850 | 0.0846 |  |  |  | 60.3 KiB | 244 |
| core/loop | ts | 102.3 | 2.605 | 2.333 | 48016 | 54.3 | 62.5 KiB | 235.3 KiB |  |
| core/loop | zig | 6.7 | 0.910 | 0.867 | 48016 | 19.0 | 62.5 KiB |  |  |
| core/loop | applescript |  | 0.179 | 0.179 |  |  |  |  |  |
| core/loop | gopher-lua |  | 0.0276 | 0.0270 |  |  |  | 44.8 KiB | 180 |
| host/conversion | ts | 172.4 | 7.473 | 7.214 | 25018 | 298.7 | 220.3 KiB | 867.1 KiB |  |
| host/immediate | ts | 111.7 | 2.172 | 1.905 | 13518 | 160.7 | 15.7 KiB | 296.5 KiB |  |
| host/properties | ts | 108.7 | 1.318 | 1.077 | 9018 | 146.1 | 15.7 KiB | 185.6 KiB |  |
| host/pump | ts | 19.6 | 0.00612 | 0.00563 | 7 | 873.8 | 0 B | 2.9 KiB |  |
| host/pump | zig | 2.9 | 0.00160 | 0.00158 | 7 | 228.7 | 0 B |  |  |
| host/suspending | ts | 116.9 | 4.204 | 3.431 | 13518 | 311.0 | 15.7 KiB | 116.0 KiB |  |
| lifecycle/load-large | ts | 14073.5 | 0.931 | 0.867 | 4609 | 202.0 | 16.3 KiB | 578 B |  |
| lifecycle/load-large | zig | 746.7 | 0.130 | 0.130 | 4609 | 28.2 | 16.3 KiB |  |  |
| lifecycle/load-small | ts | 30.7 | 0.00772 | 0.00696 | 7 | 1103.2 | 0 B | 83 B |  |
| lifecycle/load-small | zig | 2.8 | 0.00166 | 0.00160 | 7 | 237.4 | 0 B |  |  |
| lifecycle/restore | ts | 230.8 | 6.775 | 6.339 | 8015 | 845.3 | 7.8 KiB | 58.6 KiB |  |
| lifecycle/rollback | ts | 251.1 | 45.743 | 44.365 | 102023 | 448.4 | 39.9 KiB | 7.5 KiB |  |
| macro/game-tick | ts | 195.6 | 4.992 | 4.721 | 67042 | 74.5 | 78.4 KiB | 9.1 KiB |  |
| macro/game-tick | zig | 12.7 | 1.218 | 1.216 | 67042 | 18.2 | 78.4 KiB |  |  |
| macro/game-tick | applescript |  | 1.345 | 1.344 |  |  |  |  |  |
| macro/game-tick | gopher-lua |  | 0.137 | 0.137 |  |  |  | 28.7 KiB | 128 |
| macro/report | ts | 113.1 | 1.557 | 1.490 | 86555 | 18.0 | 1.2 MiB | 2.2 MiB |  |
| macro/report | zig | 7.6 | 0.482 | 0.477 | 86555 | 5.6 | 1.2 MiB |  |  |
| macro/report | applescript |  | 3.077 | 3.061 |  |  |  |  |  |
| macro/report | gopher-lua |  | 0.133 | 0.128 |  |  |  | 33.1 KiB | 1291 |
| macro/transform | ts | 154.0 | 1.819 | 1.742 | 20664 | 88.0 | 6.1 MiB | 739.2 KiB |  |
| macro/transform | zig | 11.0 | 0.264 | 0.263 | 20664 | 12.8 | 6.1 MiB |  |  |
| macro/transform | applescript |  | 0.333 | 0.332 |  |  |  |  |  |
| macro/transform | gopher-lua |  | 0.132 | 0.130 |  |  |  | 268.0 KiB | 4538 |
| messaging/joins | ts | 220.2 | 26.689 | 25.541 | 127218 | 209.8 | 239.1 KiB | 7.7 KiB |  |
| messaging/parents | ts | 142.9 | 17.002 | 16.503 | 67518 | 251.8 | 93.8 KiB | 76.1 KiB |  |
| messaging/sends | ts | 159.6 | 17.807 | 15.432 | 67518 | 263.7 | 93.8 KiB | 135.2 KiB |  |
| messaging/suspend | ts | 97.2 | 15.925 | 15.359 | 48018 | 331.6 | 31.3 KiB | 390 B |  |
| messaging/suspend | zig | 6.4 | 2.712 | 2.707 | 48018 | 56.5 | 31.3 KiB |  |  |
| numbers/add | ts | 98.8 | 1.537 | 1.425 | 26030 | 59.0 | 31.4 KiB | 257.5 KiB |  |
| numbers/add | zig | 6.6 | 0.424 | 0.424 | 26030 | 16.3 | 31.4 KiB |  |  |
| numbers/add | applescript |  | 0.225 | 0.225 |  |  |  |  |  |
| numbers/add | gopher-lua |  | 0.0268 | 0.0266 |  |  |  | 43.9 KiB | 177 |
| numbers/divide | ts | 93.5 | 1.279 | 1.163 | 18031 | 70.9 | 31.4 KiB | 286.8 KiB |  |
| numbers/divide | zig | 6.8 | 0.307 | 0.306 | 18031 | 17.0 | 31.4 KiB |  |  |
| numbers/divide | applescript |  | 0.190 | 0.190 |  |  |  |  |  |
| numbers/divide | gopher-lua |  | 0.0199 | 0.0198 |  |  |  | 28.3 KiB | 115 |
| numbers/multiply | ts | 99.8 | 1.092 | 0.998 | 18031 | 60.5 | 31.4 KiB | 191.1 KiB |  |
| numbers/multiply | zig | 6.8 | 0.279 | 0.276 | 18031 | 15.5 | 31.4 KiB |  |  |
| numbers/multiply | applescript |  | 0.172 | 0.172 |  |  |  |  |  |
| numbers/multiply | gopher-lua |  | 0.0185 | 0.0185 |  |  |  | 29.1 KiB | 118 |
| numbers/quantity | ts | 119.1 | 1.227 | 1.083 | 14579 | 84.1 | 39.1 KiB | 258.5 KiB |  |
| numbers/quantity | zig | 9.1 | 0.281 | 0.281 | 14579 | 19.3 | 39.1 KiB |  |  |
| numbers/quantity | applescript |  | 0.117 | 0.116 |  |  |  |  |  |
| numbers/quantity | gopher-lua |  | 0.0125 | 0.0115 |  |  |  | 16.5 KiB | 67 |
| text/build | ts | 79.0 | 0.744 | 0.687 | 28928 | 25.7 | 374.8 KiB | 270.7 KiB |  |
| text/build | zig | 5.9 | 0.0964 | 0.0952 | 28928 | 3.3 | 374.8 KiB |  |  |
| text/build | applescript |  | 0.364 | 0.363 |  |  |  |  |  |
| text/build | gopher-lua |  | 0.105 | 0.104 |  |  |  | 400.8 KiB | 1024 |
| text/graphemes | ts | 99.5 | 4.897 | 4.674 | 43518 | 112.5 | 144.1 KiB | 652.5 KiB |  |
| text/graphemes | zig | 7.4 | 1.018 | 1.016 | 43518 | 23.4 | 144.1 KiB |  |  |
| text/index | ts | 109.8 | 2.165 | 2.000 | 26640 | 81.3 | 49.9 KiB | 395.6 KiB |  |
| text/index | zig | 7.8 | 0.601 | 0.599 | 26640 | 22.6 | 49.9 KiB |  |  |
| text/index | applescript |  | 0.857 | 0.854 |  |  |  |  |  |
| text/index | gopher-lua |  | 0.169 | 0.168 |  |  |  | 29.3 KiB | 1055 |
| text/iterate | ts | 92.6 | 2.608 | 2.457 | 30318 | 86.0 | 93.0 KiB | 403.8 KiB |  |
| text/iterate | zig | 7.1 | 0.482 | 0.482 | 30318 | 15.9 | 93.0 KiB |  |  |
| text/iterate | applescript |  | 3.317 | 3.282 |  |  |  |  |  |
| text/iterate | gopher-lua |  | 0.380 | 0.376 |  |  |  | 187.3 KiB | 9847 |
| text/patterns | ts | 121.5 | 5.285 | 4.935 | 13818 | 382.5 | 225.9 KiB | 1.9 MiB |  |
| text/patterns | zig | 7.3 | 0.547 | 0.546 | 13818 | 39.6 | 225.9 KiB |  |  |
| text/patterns | applescript |  | 15.233 | 15.233 |  |  |  |  |  |
| text/patterns | gopher-lua |  | 0.538 | 0.537 |  |  |  | 390.8 KiB | 17736 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- core/fib@slice=10 on zig: 99.0 ns/Fuel, 5.7× the median
- collections/map-build on zig: 62.1 ns/Fuel, 3.6× the median
- host/pump on zig: 228.7 ns/Fuel, 13.3× the median
- messaging/suspend on zig: 56.5 ns/Fuel, 3.3× the median
- lifecycle/load-small on zig: 237.4 ns/Fuel, 13.8× the median
- text/patterns on ts: 382.5 ns/Fuel, 4.3× the median
- host/suspending on ts: 311.0 ns/Fuel, 3.5× the median
- host/conversion on ts: 298.7 ns/Fuel, 3.3× the median
- host/pump on ts: 873.8 ns/Fuel, 9.8× the median
- messaging/suspend on ts: 331.6 ns/Fuel, 3.7× the median
- lifecycle/load-small on ts: 1103.2 ns/Fuel, 12.3× the median
- lifecycle/rollback on ts: 448.4 ns/Fuel, 5.0× the median

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
