# Benchmark results, 2026-10-15

Commit `0aed90d3` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 3, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | ts | 193.0 | 10.837 | 10.627 | 89459 | 121.1 | 195.6 KiB | 1.3 MiB |  |
| collections/iterate | zig | 13.5 | 1.375 | 1.372 | 89459 | 15.4 | 195.6 KiB |  |  |
| collections/iterate | applescript |  | 6.005 | 5.995 |  |  |  |  |  |
| collections/iterate | gopher-lua |  | 0.393 | 0.392 |  |  |  | 108.9 KiB | 6741 |
| collections/list-append | ts | 189.2 | 4.739 | 4.218 | 52056 | 91.0 | 78.3 KiB | 881.4 KiB |  |
| collections/list-append | zig | 10.0 | 0.867 | 0.866 | 52056 | 16.7 | 78.3 KiB |  |  |
| collections/list-append | applescript |  | 1.403 | 1.370 |  |  |  |  |  |
| collections/list-append | gopher-lua |  | 0.177 | 0.177 |  |  |  | 203.9 KiB | 4315 |
| collections/list-build | ts | 114.3 | 1.015 | 0.966 | 19091 | 53.2 | 2.9 MiB | 337.8 KiB |  |
| collections/list-build | zig | 7.1 | 0.193 | 0.193 | 19091 | 10.1 | 2.9 MiB |  |  |
| collections/list-build | applescript |  | 0.225 | 0.225 |  |  |  |  |  |
| collections/list-build | gopher-lua |  | 0.0372 | 0.0371 |  |  |  | 35.4 KiB | 1045 |
| collections/list-update | ts | 163.4 | 3.843 | 2.234 | 28553 | 134.6 | 23.8 KiB | 618.2 KiB |  |
| collections/list-update | zig | 10.1 | 0.504 | 0.503 | 28553 | 17.7 | 23.8 KiB |  |  |
| collections/list-update | applescript |  | 0.370 | 0.368 |  |  |  |  |  |
| collections/list-update | gopher-lua |  | 0.0258 | 0.0257 |  |  |  | 22.4 KiB | 106 |
| collections/map-build | ts | 147.2 | 1.086 | 1.040 | 14094 | 77.1 | 24.3 KiB | 235.3 KiB |  |
| collections/map-build | zig | 9.0 | 0.863 | 0.845 | 14094 | 61.2 | 24.3 KiB |  |  |
| collections/map-build | applescript |  | 5.795 | 5.791 |  |  |  |  |  |
| collections/map-build | gopher-lua |  | 0.0784 | 0.0783 |  |  |  | 90.5 KiB | 1291 |
| collections/map-update | ts | 170.7 | 0.782 | 0.701 | 8056 | 97.0 | 12.1 KiB | 162.9 KiB |  |
| collections/map-update | zig | 10.9 | 0.198 | 0.198 | 8056 | 24.6 | 12.1 KiB |  |  |
| collections/map-update | applescript |  | 3.499 | 3.480 |  |  |  |  |  |
| collections/map-update | gopher-lua |  | 0.0185 | 0.0184 |  |  |  | 10.2 KiB | 76 |
| core/calls | ts | 135.8 | 1.921 | 1.807 | 46018 | 41.7 | 31.3 KiB | 177.5 KiB |  |
| core/calls | zig | 7.7 | 0.588 | 0.586 | 46018 | 12.8 | 31.3 KiB |  |  |
| core/calls | applescript |  | 0.596 | 0.596 |  |  |  |  |  |
| core/calls | gopher-lua |  | 0.0710 | 0.0705 |  |  |  | 44.8 KiB | 180 |
| core/fib | ts | 120.2 | 2.174 | 1.758 | 46365 | 46.9 | 46.2 KiB | 287.4 KiB |  |
| core/fib | zig | 7.2 | 0.587 | 0.584 | 46365 | 12.7 | 46.2 KiB |  |  |
| core/fib | applescript |  | 0.472 | 0.469 |  |  |  |  |  |
| core/fib | gopher-lua |  | 0.0708 | 0.0705 |  |  |  | 63 B | 1 |
| core/fib@slice=10 | ts | 94.6 | 10.864 | 9.855 | 46365 | 234.3 | 46.2 KiB | 838.3 KiB |  |
| core/fib@slice=10 | zig | 7.2 | 4.612 | 4.523 | 46365 | 99.5 | 46.2 KiB |  |  |
| core/fib@slice=100 | ts | 82.1 | 2.807 | 2.665 | 46365 | 60.5 | 46.2 KiB | 21.6 KiB |  |
| core/fib@slice=100 | zig | 7.2 | 1.008 | 0.994 | 46365 | 21.7 | 46.2 KiB |  |  |
| core/fib@slice=1000 | ts | 81.6 | 2.045 | 1.948 | 46365 | 44.1 | 46.2 KiB | 37.0 KiB |  |
| core/fib@slice=1000 | zig | 7.2 | 0.637 | 0.634 | 46365 | 13.7 | 46.2 KiB |  |  |
| core/fib@slice=10000 | ts | 79.9 | 1.939 | 1.848 | 46365 | 41.8 | 46.2 KiB | 1.7 KiB |  |
| core/fib@slice=10000 | zig | 7.1 | 0.597 | 0.595 | 46365 | 12.9 | 46.2 KiB |  |  |
| core/lambdas | ts | 164.8 | 2.747 | 2.556 | 58027 | 47.3 | 62.6 KiB | 437.9 KiB |  |
| core/lambdas | zig | 8.8 | 0.771 | 0.768 | 58027 | 13.3 | 62.6 KiB |  |  |
| core/lambdas | applescript |  | 0.654 | 0.647 |  |  |  |  |  |
| core/lambdas | gopher-lua |  | 0.0850 | 0.0850 |  |  |  | 60.3 KiB | 244 |
| core/loop | ts | 102.5 | 2.544 | 2.322 | 48016 | 53.0 | 62.5 KiB | 165.7 KiB |  |
| core/loop | zig | 6.7 | 0.903 | 0.851 | 48016 | 18.8 | 62.5 KiB |  |  |
| core/loop | applescript |  | 0.179 | 0.179 |  |  |  |  |  |
| core/loop | gopher-lua |  | 0.0260 | 0.0257 |  |  |  | 44.8 KiB | 180 |
| host/conversion | ts | 171.3 | 7.598 | 7.302 | 25018 | 303.7 | 220.3 KiB | 285.6 KiB |  |
| host/immediate | ts | 112.5 | 2.201 | 2.087 | 13518 | 162.9 | 15.7 KiB | 379.7 KiB |  |
| host/properties | ts | 107.0 | 1.340 | 1.087 | 9018 | 148.6 | 15.7 KiB | 266.7 KiB |  |
| host/pump | ts | 19.7 | 0.00597 | 0.00577 | 7 | 853.2 | 0 B | 2.5 KiB |  |
| host/pump | zig | 2.9 | 0.00159 | 0.00157 | 7 | 227.3 | 0 B |  |  |
| host/suspending | ts | 116.2 | 4.310 | 4.085 | 13518 | 318.8 | 15.7 KiB | 32.1 KiB |  |
| lifecycle/load-large | ts | 14303.6 | 0.887 | 0.853 | 4609 | 192.6 | 16.3 KiB | 22 B |  |
| lifecycle/load-large | zig | 750.0 | 0.140 | 0.139 | 4609 | 30.4 | 16.3 KiB |  |  |
| lifecycle/load-small | ts | 30.8 | 0.00752 | 0.00703 | 7 | 1074.6 | 0 B | 106 B |  |
| lifecycle/load-small | zig | 2.8 | 0.00159 | 0.00156 | 7 | 226.7 | 0 B |  |  |
| lifecycle/restore | ts | 232.8 | 6.866 | 6.531 | 8015 | 856.6 | 7.8 KiB | 64.2 KiB |  |
| lifecycle/rollback | ts | 252.2 | 45.092 | 43.691 | 102023 | 442.0 | 39.9 KiB | 5.7 KiB |  |
| macro/game-tick | ts | 197.6 | 5.064 | 4.842 | 67042 | 75.5 | 78.4 KiB | 12.5 KiB |  |
| macro/game-tick | zig | 12.7 | 1.223 | 1.218 | 67042 | 18.2 | 78.4 KiB |  |  |
| macro/game-tick | applescript |  | 1.341 | 1.340 |  |  |  |  |  |
| macro/game-tick | gopher-lua |  | 0.126 | 0.126 |  |  |  | 28.7 KiB | 128 |
| macro/report | ts | 113.1 | 1.628 | 1.542 | 86555 | 18.8 | 1.2 MiB | 2.1 MiB |  |
| macro/report | zig | 7.7 | 1.179 | 1.177 | 86555 | 13.6 | 1.2 MiB |  |  |
| macro/report | applescript |  | 3.114 | 3.098 |  |  |  |  |  |
| macro/report | gopher-lua |  | 0.127 | 0.127 |  |  |  | 33.1 KiB | 1291 |
| macro/transform | ts | 155.2 | 1.827 | 1.750 | 20664 | 88.4 | 6.1 MiB | 641.9 KiB |  |
| macro/transform | zig | 11.1 | 0.291 | 0.275 | 20664 | 14.1 | 6.1 MiB |  |  |
| macro/transform | applescript |  | 0.333 | 0.333 |  |  |  |  |  |
| macro/transform | gopher-lua |  | 0.122 | 0.122 |  |  |  | 268.0 KiB | 4538 |
| messaging/joins | ts | 221.6 | 26.387 | 25.427 | 127218 | 207.4 | 239.1 KiB | 20.3 KiB |  |
| messaging/parents | ts | 142.6 | 17.979 | 17.422 | 67518 | 266.3 | 93.8 KiB | 150.1 KiB |  |
| messaging/sends | ts | 158.2 | 15.414 | 14.440 | 67518 | 228.3 | 93.8 KiB | 192.4 KiB |  |
| messaging/suspend | ts | 97.5 | 16.344 | 15.757 | 48018 | 340.4 | 31.3 KiB | 6.9 KiB |  |
| messaging/suspend | zig | 7.2 | 2.717 | 2.716 | 48018 | 56.6 | 31.3 KiB |  |  |
| numbers/add | ts | 123.5 | 1.553 | 1.440 | 26030 | 59.7 | 31.4 KiB | 236.0 KiB |  |
| numbers/add | zig | 6.6 | 0.423 | 0.422 | 26030 | 16.3 | 31.4 KiB |  |  |
| numbers/add | applescript |  | 0.223 | 0.221 |  |  |  |  |  |
| numbers/add | gopher-lua |  | 0.0264 | 0.0263 |  |  |  | 43.9 KiB | 177 |
| numbers/divide | ts | 89.9 | 1.277 | 1.189 | 18031 | 70.8 | 31.4 KiB | 326.1 KiB |  |
| numbers/divide | zig | 6.8 | 0.313 | 0.311 | 18031 | 17.3 | 31.4 KiB |  |  |
| numbers/divide | applescript |  | 0.186 | 0.185 |  |  |  |  |  |
| numbers/divide | gopher-lua |  | 0.0198 | 0.0197 |  |  |  | 28.3 KiB | 115 |
| numbers/multiply | ts | 91.0 | 1.066 | 0.990 | 18031 | 59.1 | 31.4 KiB | 213.2 KiB |  |
| numbers/multiply | zig | 6.8 | 0.271 | 0.271 | 18031 | 15.0 | 31.4 KiB |  |  |
| numbers/multiply | applescript |  | 0.169 | 0.169 |  |  |  |  |  |
| numbers/multiply | gopher-lua |  | 0.0183 | 0.0182 |  |  |  | 29.1 KiB | 118 |
| numbers/quantity | ts | 117.7 | 1.242 | 1.119 | 14579 | 85.2 | 39.1 KiB | 242.0 KiB |  |
| numbers/quantity | zig | 8.4 | 0.279 | 0.279 | 14579 | 19.1 | 39.1 KiB |  |  |
| numbers/quantity | applescript |  | 0.115 | 0.114 |  |  |  |  |  |
| numbers/quantity | gopher-lua |  | 0.0114 | 0.0114 |  |  |  | 16.5 KiB | 67 |
| text/build | ts | 79.6 | 0.749 | 0.696 | 28928 | 25.9 | 374.8 KiB | 254.6 KiB |  |
| text/build | zig | 5.8 | 0.412 | 0.411 | 28928 | 14.2 | 374.8 KiB |  |  |
| text/build | applescript |  | 0.359 | 0.359 |  |  |  |  |  |
| text/build | gopher-lua |  | 0.0640 | 0.0632 |  |  |  | 400.8 KiB | 1024 |
| text/graphemes | ts | 98.7 | 5.036 | 4.741 | 43518 | 115.7 | 144.1 KiB | 534.0 KiB |  |
| text/graphemes | zig | 7.4 | 1.006 | 1.003 | 43518 | 23.1 | 144.1 KiB |  |  |
| text/index | ts | 111.7 | 2.197 | 2.036 | 26640 | 82.5 | 49.9 KiB | 360.2 KiB |  |
| text/index | zig | 7.9 | 0.601 | 0.600 | 26640 | 22.5 | 49.9 KiB |  |  |
| text/index | applescript |  | 0.854 | 0.844 |  |  |  |  |  |
| text/index | gopher-lua |  | 0.112 | 0.112 |  |  |  | 29.3 KiB | 1055 |
| text/iterate | ts | 92.5 | 2.636 | 2.485 | 30318 | 86.9 | 93.0 KiB | 572.4 KiB |  |
| text/iterate | zig | 7.3 | 0.509 | 0.509 | 30318 | 16.8 | 93.0 KiB |  |  |
| text/iterate | applescript |  | 3.265 | 3.261 |  |  |  |  |  |
| text/iterate | gopher-lua |  | 0.164 | 0.164 |  |  |  | 187.3 KiB | 9847 |
| text/patterns | ts | 120.5 | 5.299 | 4.932 | 13818 | 383.5 | 225.9 KiB | 1.8 MiB |  |
| text/patterns | zig | 7.3 | 0.547 | 0.547 | 13818 | 39.6 | 225.9 KiB |  |  |
| text/patterns | applescript |  | 15.252 | 15.212 |  |  |  |  |  |
| text/patterns | gopher-lua |  | 0.245 | 0.245 |  |  |  | 390.8 KiB | 17736 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- core/fib@slice=10 on zig: 99.5 ns/Fuel, 5.7× the median
- collections/map-build on zig: 61.2 ns/Fuel, 3.5× the median
- host/pump on zig: 227.3 ns/Fuel, 13.0× the median
- messaging/suspend on zig: 56.6 ns/Fuel, 3.2× the median
- lifecycle/load-small on zig: 226.7 ns/Fuel, 13.0× the median
- text/patterns on ts: 383.5 ns/Fuel, 4.3× the median
- host/suspending on ts: 318.8 ns/Fuel, 3.6× the median
- host/conversion on ts: 303.7 ns/Fuel, 3.4× the median
- host/pump on ts: 853.2 ns/Fuel, 9.5× the median
- messaging/suspend on ts: 340.4 ns/Fuel, 3.8× the median
- lifecycle/load-small on ts: 1074.6 ns/Fuel, 12.0× the median
- lifecycle/rollback on ts: 442.0 ns/Fuel, 4.9× the median

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
