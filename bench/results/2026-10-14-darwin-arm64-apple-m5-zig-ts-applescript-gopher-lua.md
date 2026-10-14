# Benchmark results, 2026-10-14

Commit `f6477343-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 3, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | ts | 241.4 | 6.765 | 6.477 | 89459 | 75.6 | 195.6 KiB | 1.8 MiB |  |
| collections/iterate | zig | 13.5 | 2.176 | 2.175 | 89459 | 24.3 | 195.6 KiB |  |  |
| collections/iterate | applescript |  | 6.011 | 5.998 |  |  |  |  |  |
| collections/iterate | gopher-lua |  | 0.391 | 0.390 |  |  |  | 108.9 KiB | 6741 |
| collections/list-append | ts | 187.3 | 7.042 | 5.519 | 52056 | 135.3 | 78.3 KiB | 961.3 KiB |  |
| collections/list-append | zig | 9.9 | 1.344 | 1.341 | 52056 | 25.8 | 78.3 KiB |  |  |
| collections/list-append | applescript |  | 1.399 | 1.396 |  |  |  |  |  |
| collections/list-append | gopher-lua |  | 0.177 | 0.176 |  |  |  | 203.9 KiB | 4315 |
| collections/list-build | ts | 114.1 | 1.335 | 1.238 | 19091 | 69.9 | 2.9 MiB | 280.7 KiB |  |
| collections/list-build | zig | 7.0 | 0.782 | 0.765 | 19091 | 40.9 | 2.9 MiB |  |  |
| collections/list-build | applescript |  | 0.227 | 0.226 |  |  |  |  |  |
| collections/list-build | gopher-lua |  | 0.0372 | 0.0371 |  |  |  | 35.4 KiB | 1045 |
| collections/list-update | ts | 191.1 | 4.464 | 2.836 | 28553 | 156.3 | 23.8 KiB | 492.3 KiB |  |
| collections/list-update | zig | 10.2 | 0.795 | 0.789 | 28553 | 27.8 | 23.8 KiB |  |  |
| collections/list-update | applescript |  | 0.371 | 0.371 |  |  |  |  |  |
| collections/list-update | gopher-lua |  | 0.0256 | 0.0256 |  |  |  | 22.4 KiB | 106 |
| collections/map-build | ts | 150.5 | 1.313 | 1.149 | 14094 | 93.2 | 24.3 KiB | 270.4 KiB |  |
| collections/map-build | zig | 8.9 | 0.956 | 0.950 | 14094 | 67.8 | 24.3 KiB |  |  |
| collections/map-build | applescript |  | 5.745 | 5.734 |  |  |  |  |  |
| collections/map-build | gopher-lua |  | 0.0787 | 0.0787 |  |  |  | 90.5 KiB | 1291 |
| collections/map-update | ts | 177.4 | 0.934 | 0.875 | 8056 | 116.0 | 12.1 KiB | 123.6 KiB |  |
| collections/map-update | zig | 11.2 | 0.286 | 0.286 | 8056 | 35.5 | 12.1 KiB |  |  |
| collections/map-update | applescript |  | 3.497 | 3.490 |  |  |  |  |  |
| collections/map-update | gopher-lua |  | 0.0187 | 0.0185 |  |  |  | 10.2 KiB | 76 |
| core/calls | ts | 131.9 | 2.711 | 2.492 | 46018 | 58.9 | 31.3 KiB | 142.4 KiB |  |
| core/calls | zig | 7.7 | 0.911 | 0.910 | 46018 | 19.8 | 31.3 KiB |  |  |
| core/calls | applescript |  | 0.594 | 0.592 |  |  |  |  |  |
| core/calls | gopher-lua |  | 0.0705 | 0.0705 |  |  |  | 44.8 KiB | 180 |
| core/fib | ts | 116.8 | 2.350 | 1.934 | 46365 | 50.7 | 46.2 KiB | 172.3 KiB |  |
| core/fib | zig | 7.2 | 0.922 | 0.920 | 46365 | 19.9 | 46.2 KiB |  |  |
| core/fib | applescript |  | 0.468 | 0.468 |  |  |  |  |  |
| core/fib | gopher-lua |  | 0.0708 | 0.0707 |  |  |  | 63 B | 1 |
| core/fib@slice=10 | ts | 92.1 | 10.731 | 9.351 | 46365 | 231.5 | 46.2 KiB | 773.7 KiB |  |
| core/fib@slice=10 | zig | 7.3 | 4.757 | 4.728 | 46365 | 102.6 | 46.2 KiB |  |  |
| core/fib@slice=100 | ts | 79.7 | 2.966 | 2.740 | 46365 | 64.0 | 46.2 KiB | 15.0 KiB |  |
| core/fib@slice=100 | zig | 7.2 | 1.341 | 1.329 | 46365 | 28.9 | 46.2 KiB |  |  |
| core/fib@slice=1000 | ts | 79.8 | 2.252 | 2.082 | 46365 | 48.6 | 46.2 KiB | 1.4 KiB |  |
| core/fib@slice=1000 | zig | 7.2 | 0.982 | 0.972 | 46365 | 21.2 | 46.2 KiB |  |  |
| core/fib@slice=10000 | ts | 77.8 | 2.154 | 2.023 | 46365 | 46.5 | 46.2 KiB | 4.0 KiB |  |
| core/fib@slice=10000 | zig | 7.2 | 0.937 | 0.935 | 46365 | 20.2 | 46.2 KiB |  |  |
| core/lambdas | ts | 160.0 | 3.814 | 3.421 | 58027 | 65.7 | 62.6 KiB | 431.7 KiB |  |
| core/lambdas | zig | 8.9 | 1.234 | 1.229 | 58027 | 21.3 | 62.6 KiB |  |  |
| core/lambdas | applescript |  | 0.642 | 0.641 |  |  |  |  |  |
| core/lambdas | gopher-lua |  | 0.0851 | 0.0851 |  |  |  | 60.3 KiB | 244 |
| core/loop | ts | 102.3 | 2.867 | 2.712 | 48016 | 59.7 | 62.5 KiB | 308.5 KiB |  |
| core/loop | zig | 6.7 | 1.333 | 1.332 | 48016 | 27.8 | 62.5 KiB |  |  |
| core/loop | applescript |  | 0.180 | 0.179 |  |  |  |  |  |
| core/loop | gopher-lua |  | 0.0257 | 0.0257 |  |  |  | 44.8 KiB | 180 |
| host/conversion | ts | 183.5 | 9.445 | 9.050 | 25018 | 377.5 | 220.3 KiB | 1.1 MiB |  |
| host/immediate | ts | 116.5 | 2.197 | 2.099 | 13518 | 162.5 | 15.7 KiB | 91.5 KiB |  |
| host/properties | ts | 109.0 | 1.928 | 1.324 | 9018 | 213.8 | 15.7 KiB | 311.2 KiB |  |
| host/pump | ts | 20.4 | 0.00718 | 0.00664 | 7 | 1026.2 | 0 B | 2.9 KiB |  |
| host/pump | zig | 2.4 | 0.00166 | 0.00165 | 7 | 237.7 | 0 B |  |  |
| host/suspending | ts | 121.6 | 5.109 | 4.065 | 13518 | 377.9 | 15.7 KiB | 626.6 KiB |  |
| lifecycle/load-large | ts | 15172.5 | 0.663 | 0.633 | 4609 | 143.9 | 16.3 KiB | 277 B |  |
| lifecycle/load-large | zig | 762.6 | 0.178 | 0.177 | 4609 | 38.6 | 16.3 KiB |  |  |
| lifecycle/load-small | ts | 30.2 | 0.00715 | 0.00661 | 7 | 1020.9 | 0 B | 3.2 KiB |  |
| lifecycle/load-small | zig | 3.2 | 0.00199 | 0.00185 | 7 | 284.3 | 0 B |  |  |
| lifecycle/restore | ts | 234.8 | 6.991 | 6.550 | 8015 | 872.2 | 7.8 KiB | 49.7 KiB |  |
| lifecycle/rollback | ts | 253.7 | 63.904 | 58.562 | 102023 | 626.4 | 39.9 KiB | 20.0 KiB |  |
| macro/game-tick | ts | 207.8 | 5.752 | 5.597 | 67042 | 85.8 | 78.4 KiB | 6.0 KiB |  |
| macro/game-tick | zig | 12.8 | 1.736 | 1.734 | 67042 | 25.9 | 78.4 KiB |  |  |
| macro/game-tick | applescript |  | 1.354 | 1.345 |  |  |  |  |  |
| macro/game-tick | gopher-lua |  | 0.128 | 0.127 |  |  |  | 28.7 KiB | 128 |
| macro/report | ts | 120.1 | 2.203 | 2.062 | 86555 | 25.5 | 1.2 MiB | 2.4 MiB |  |
| macro/report | zig | 7.7 | 1.221 | 1.220 | 86555 | 14.1 | 1.2 MiB |  |  |
| macro/report | applescript |  | 3.105 | 3.096 |  |  |  |  |  |
| macro/report | gopher-lua |  | 0.126 | 0.125 |  |  |  | 33.1 KiB | 1291 |
| macro/transform | ts | 164.1 | 3.104 | 3.018 | 20664 | 150.2 | 6.1 MiB | 2.8 KiB |  |
| macro/transform | zig | 11.0 | 0.685 | 0.685 | 20664 | 33.2 | 6.1 MiB |  |  |
| macro/transform | applescript |  | 0.335 | 0.334 |  |  |  |  |  |
| macro/transform | gopher-lua |  | 0.123 | 0.123 |  |  |  | 268.0 KiB | 4538 |
| messaging/joins | ts | 227.7 | 20.656 | 18.690 | 127218 | 162.4 | 239.1 KiB | 44.4 KiB |  |
| messaging/parents | ts | 147.8 | 17.582 | 17.088 | 67518 | 260.4 | 93.8 KiB | 63.6 KiB |  |
| messaging/sends | ts | 172.4 | 16.077 | 12.849 | 67518 | 238.1 | 93.8 KiB | 928.4 KiB |  |
| messaging/suspend | ts | 98.5 | 17.095 | 16.398 | 48018 | 356.0 | 31.3 KiB | 1.6 KiB |  |
| messaging/suspend | zig | 6.4 | 3.059 | 3.026 | 48018 | 63.7 | 31.3 KiB |  |  |
| numbers/add | ts | 115.9 | 2.409 | 2.212 | 26030 | 92.5 | 31.4 KiB | 240.1 KiB |  |
| numbers/add | zig | 6.6 | 0.679 | 0.676 | 26030 | 26.1 | 31.4 KiB |  |  |
| numbers/add | applescript |  | 0.229 | 0.226 |  |  |  |  |  |
| numbers/add | gopher-lua |  | 0.0265 | 0.0264 |  |  |  | 43.9 KiB | 177 |
| numbers/divide | ts | 87.1 | 2.140 | 2.035 | 18031 | 118.7 | 31.4 KiB | 393.6 KiB |  |
| numbers/divide | zig | 6.8 | 0.958 | 0.956 | 18031 | 53.2 | 31.4 KiB |  |  |
| numbers/divide | applescript |  | 0.191 | 0.191 |  |  |  |  |  |
| numbers/divide | gopher-lua |  | 0.0200 | 0.0199 |  |  |  | 28.3 KiB | 115 |
| numbers/multiply | ts | 92.0 | 1.528 | 1.404 | 18031 | 84.7 | 31.4 KiB | 258.3 KiB |  |
| numbers/multiply | zig | 6.9 | 0.439 | 0.439 | 18031 | 24.3 | 31.4 KiB |  |  |
| numbers/multiply | applescript |  | 0.174 | 0.173 |  |  |  |  |  |
| numbers/multiply | gopher-lua |  | 0.0183 | 0.0183 |  |  |  | 29.1 KiB | 118 |
| numbers/quantity | ts | 154.0 | 4.114 | 3.824 | 14579 | 282.2 | 39.1 KiB | 478.7 KiB |  |
| numbers/quantity | zig | 8.3 | 1.264 | 1.261 | 14579 | 86.7 | 39.1 KiB |  |  |
| numbers/quantity | applescript |  | 0.119 | 0.118 |  |  |  |  |  |
| numbers/quantity | gopher-lua |  | 0.0115 | 0.0114 |  |  |  | 16.5 KiB | 67 |
| text/build | ts | 95.8 | 1.105 | 1.051 | 28928 | 38.2 | 374.8 KiB | 197.6 KiB |  |
| text/build | zig | 5.8 | 0.462 | 0.461 | 28928 | 16.0 | 374.8 KiB |  |  |
| text/build | applescript |  | 0.371 | 0.361 |  |  |  |  |  |
| text/build | gopher-lua |  | 0.0648 | 0.0640 |  |  |  | 400.8 KiB | 1024 |
| text/graphemes | ts | 107.1 | 6.021 | 5.555 | 43518 | 138.4 | 144.1 KiB | 1.0 MiB |  |
| text/graphemes | zig | 7.4 | 1.364 | 1.362 | 43518 | 31.3 | 144.1 KiB |  |  |
| text/index | ts | 129.2 | 7.200 | 6.350 | 26640 | 270.3 | 49.9 KiB | 1.1 MiB |  |
| text/index | zig | 7.8 | 1.550 | 1.547 | 26640 | 58.2 | 49.9 KiB |  |  |
| text/index | applescript |  | 0.875 | 0.865 |  |  |  |  |  |
| text/index | gopher-lua |  | 0.112 | 0.112 |  |  |  | 29.3 KiB | 1055 |
| text/iterate | ts | 110.8 | 3.645 | 3.465 | 30318 | 120.2 | 93.0 KiB | 914.3 KiB |  |
| text/iterate | zig | 7.0 | 0.740 | 0.740 | 30318 | 24.4 | 93.0 KiB |  |  |
| text/iterate | applescript |  | 3.397 | 3.321 |  |  |  |  |  |
| text/iterate | gopher-lua |  | 0.165 | 0.165 |  |  |  | 187.3 KiB | 9847 |
| text/patterns | ts | 130.0 | 5.894 | 5.533 | 13818 | 426.6 | 225.9 KiB | 1.6 MiB |  |
| text/patterns | zig | 7.4 | 0.633 | 0.632 | 13818 | 45.8 | 225.9 KiB |  |  |
| text/patterns | applescript |  | 15.390 | 15.324 |  |  |  |  |  |
| text/patterns | gopher-lua |  | 0.248 | 0.248 |  |  |  | 390.8 KiB | 17736 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- core/fib@slice=10 on zig: 102.6 ns/Fuel, 3.6× the median
- numbers/quantity on zig: 86.7 ns/Fuel, 3.1× the median
- host/pump on zig: 237.7 ns/Fuel, 8.4× the median
- lifecycle/load-small on zig: 284.3 ns/Fuel, 10.0× the median
- text/patterns on ts: 426.6 ns/Fuel, 3.1× the median
- host/pump on ts: 1026.2 ns/Fuel, 7.5× the median
- lifecycle/load-small on ts: 1020.9 ns/Fuel, 7.5× the median
- lifecycle/rollback on ts: 626.4 ns/Fuel, 4.6× the median

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
