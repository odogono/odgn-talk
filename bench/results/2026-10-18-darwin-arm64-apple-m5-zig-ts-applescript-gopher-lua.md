# Benchmark results, 2026-10-18

Commit `reactor-v0.5.0-76-g63675505` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host zig cc -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 3, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | ts | 195.7 | 10.908 | 10.659 | 89459 | 121.9 | 195.6 KiB | 2.0 MiB |  |
| collections/iterate | zig | 14.5 | 1.256 | 1.255 | 89459 | 14.0 | 195.6 KiB |  |  |
| collections/iterate | applescript |  | 6.500 | 6.401 |  |  |  |  |  |
| collections/iterate | gopher-lua |  | 0.393 | 0.393 |  |  |  | 108.9 KiB | 6741 |
| collections/list-append | ts | 192.8 | 4.784 | 4.292 | 52056 | 91.9 | 78.3 KiB | 690.8 KiB |  |
| collections/list-append | zig | 10.7 | 0.795 | 0.792 | 52056 | 15.3 | 78.3 KiB |  |  |
| collections/list-append | applescript |  | 1.450 | 1.447 |  |  |  |  |  |
| collections/list-append | gopher-lua |  | 0.176 | 0.176 |  |  |  | 203.9 KiB | 4315 |
| collections/list-build | ts | 117.7 | 1.012 | 0.955 | 19091 | 53.0 | 2.9 MiB | 304.5 KiB |  |
| collections/list-build | zig | 7.6 | 0.182 | 0.181 | 19091 | 9.5 | 2.9 MiB |  |  |
| collections/list-build | applescript |  | 0.241 | 0.239 |  |  |  |  |  |
| collections/list-build | gopher-lua |  | 0.0374 | 0.0372 |  |  |  | 35.4 KiB | 1045 |
| collections/list-update | ts | 164.7 | 3.831 | 2.235 | 28553 | 134.2 | 23.8 KiB | 471.8 KiB |  |
| collections/list-update | zig | 10.5 | 0.466 | 0.466 | 28553 | 16.3 | 23.8 KiB |  |  |
| collections/list-update | applescript |  | 0.391 | 0.389 |  |  |  |  |  |
| collections/list-update | gopher-lua |  | 0.0257 | 0.0256 |  |  |  | 22.4 KiB | 106 |
| collections/map-build | ts | 144.8 | 1.098 | 1.031 | 14094 | 77.9 | 24.3 KiB | 287.0 KiB |  |
| collections/map-build | zig | 9.8 | 0.333 | 0.332 | 14094 | 23.6 | 24.3 KiB |  |  |
| collections/map-build | applescript |  | 5.919 | 5.841 |  |  |  |  |  |
| collections/map-build | gopher-lua |  | 0.0785 | 0.0783 |  |  |  | 90.5 KiB | 1291 |
| collections/map-update | ts | 171.1 | 0.779 | 0.730 | 8056 | 96.7 | 12.1 KiB | 148.3 KiB |  |
| collections/map-update | zig | 11.7 | 0.193 | 0.192 | 8056 | 23.9 | 12.1 KiB |  |  |
| collections/map-update | applescript |  | 3.610 | 3.502 |  |  |  |  |  |
| collections/map-update | gopher-lua |  | 0.0189 | 0.0184 |  |  |  | 10.2 KiB | 76 |
| core/calls | ts | 145.1 | 2.027 | 1.812 | 46018 | 44.0 | 31.3 KiB | 189.1 KiB |  |
| core/calls | zig | 8.1 | 0.565 | 0.561 | 46018 | 12.3 | 31.3 KiB |  |  |
| core/calls | applescript |  | 0.601 | 0.597 |  |  |  |  |  |
| core/calls | gopher-lua |  | 0.0713 | 0.0712 |  |  |  | 44.8 KiB | 180 |
| core/fib | ts | 121.7 | 2.195 | 1.764 | 46365 | 47.3 | 46.2 KiB | 228.5 KiB |  |
| core/fib | zig | 7.4 | 0.567 | 0.566 | 46365 | 12.2 | 46.2 KiB |  |  |
| core/fib | applescript |  | 0.472 | 0.468 |  |  |  |  |  |
| core/fib | gopher-lua |  | 0.0756 | 0.0741 |  |  |  | 64 B | 1 |
| core/fib@slice=10 | ts | 97.0 | 10.277 | 9.465 | 46365 | 221.6 | 46.2 KiB | 485.7 KiB |  |
| core/fib@slice=10 | zig | 7.4 | 1.553 | 1.549 | 46365 | 33.5 | 46.2 KiB |  |  |
| core/fib@slice=100 | ts | 83.8 | 2.836 | 2.638 | 46365 | 61.2 | 46.2 KiB | 28.5 KiB |  |
| core/fib@slice=100 | zig | 7.4 | 0.679 | 0.678 | 46365 | 14.6 | 46.2 KiB |  |  |
| core/fib@slice=1000 | ts | 82.2 | 2.038 | 1.920 | 46365 | 44.0 | 46.2 KiB | 36.0 KiB |  |
| core/fib@slice=1000 | zig | 7.3 | 0.574 | 0.571 | 46365 | 12.4 | 46.2 KiB |  |  |
| core/fib@slice=10000 | ts | 80.8 | 2.033 | 1.875 | 46365 | 43.8 | 46.2 KiB | 11.1 KiB |  |
| core/fib@slice=10000 | zig | 7.4 | 0.563 | 0.563 | 46365 | 12.2 | 46.2 KiB |  |  |
| core/lambdas | ts | 171.5 | 2.765 | 2.525 | 58027 | 47.7 | 62.6 KiB | 378.0 KiB |  |
| core/lambdas | zig | 9.3 | 0.742 | 0.741 | 58027 | 12.8 | 62.6 KiB |  |  |
| core/lambdas | applescript |  | 0.650 | 0.649 |  |  |  |  |  |
| core/lambdas | gopher-lua |  | 0.0850 | 0.0849 |  |  |  | 60.3 KiB | 244 |
| core/loop | ts | 106.1 | 2.640 | 2.387 | 48016 | 55.0 | 62.5 KiB | 219.9 KiB |  |
| core/loop | zig | 7.2 | 0.794 | 0.778 | 48016 | 16.5 | 62.5 KiB |  |  |
| core/loop | applescript |  | 0.180 | 0.180 |  |  |  |  |  |
| core/loop | gopher-lua |  | 0.0285 | 0.0269 |  |  |  | 44.8 KiB | 180 |
| host/conversion | ts | 172.1 | 7.604 | 7.257 | 25018 | 304.0 | 220.3 KiB | 389.0 KiB |  |
| host/immediate | ts | 114.0 | 2.180 | 2.096 | 13518 | 161.3 | 15.7 KiB | 416.2 KiB |  |
| host/properties | ts | 110.4 | 1.343 | 1.095 | 9018 | 148.9 | 15.7 KiB | 126.0 KiB |  |
| host/pump | ts | 19.9 | 0.00610 | 0.00570 | 7 | 871.2 | 0 B | 2.8 KiB |  |
| host/pump | zig | 2.4 | 0.000904 | 0.000894 | 7 | 129.1 | 0 B |  |  |
| host/suspending | ts | 119.1 | 4.186 | 3.506 | 13518 | 309.7 | 15.7 KiB | 104.9 KiB |  |
| lifecycle/load-large | ts | 14336.6 | 0.893 | 0.859 | 4609 | 193.9 | 16.3 KiB | 65 B |  |
| lifecycle/load-large | zig | 793.4 | 0.127 | 0.127 | 4609 | 27.5 | 16.3 KiB |  |  |
| lifecycle/load-small | ts | 30.5 | 0.00768 | 0.00720 | 7 | 1096.4 | 0 B | 119 B |  |
| lifecycle/load-small | zig | 3.4 | 0.000891 | 0.000890 | 7 | 127.2 | 0 B |  |  |
| lifecycle/restore | ts | 232.3 | 6.644 | 6.332 | 8015 | 829.0 | 7.8 KiB | 80.8 KiB |  |
| lifecycle/rollback | ts | 253.1 | 48.778 | 46.000 | 102023 | 478.1 | 39.9 KiB | 17.2 KiB |  |
| macro/game-tick | ts | 196.9 | 5.007 | 4.760 | 67042 | 74.7 | 78.4 KiB | 18.4 KiB |  |
| macro/game-tick | zig | 13.3 | 1.214 | 1.210 | 67042 | 18.1 | 78.4 KiB |  |  |
| macro/game-tick | applescript |  | 1.451 | 1.443 |  |  |  |  |  |
| macro/game-tick | gopher-lua |  | 0.128 | 0.127 |  |  |  | 28.7 KiB | 128 |
| macro/report | ts | 114.7 | 1.552 | 1.491 | 86555 | 17.9 | 1.2 MiB | 2.2 MiB |  |
| macro/report | zig | 8.6 | 0.476 | 0.475 | 86555 | 5.5 | 1.2 MiB |  |  |
| macro/report | applescript |  | 3.156 | 3.125 |  |  |  |  |  |
| macro/report | gopher-lua |  | 0.124 | 0.123 |  |  |  | 33.1 KiB | 1291 |
| macro/transform | ts | 156.9 | 1.848 | 1.766 | 20664 | 89.4 | 6.1 MiB | 618.5 KiB |  |
| macro/transform | zig | 11.4 | 0.258 | 0.257 | 20664 | 12.5 | 6.1 MiB |  |  |
| macro/transform | applescript |  | 0.362 | 0.356 |  |  |  |  |  |
| macro/transform | gopher-lua |  | 0.121 | 0.120 |  |  |  | 268.0 KiB | 4538 |
| messaging/joins | ts | 217.0 | 26.290 | 25.603 | 127218 | 206.7 | 239.1 KiB | 10.5 KiB |  |
| messaging/parents | ts | 142.9 | 17.533 | 16.945 | 67518 | 259.7 | 93.8 KiB | 167.4 KiB |  |
| messaging/sends | ts | 158.3 | 15.319 | 14.699 | 67518 | 226.9 | 93.8 KiB | 223.3 KiB |  |
| messaging/suspend | ts | 96.0 | 16.579 | 15.858 | 48018 | 345.3 | 31.3 KiB | 1.2 KiB |  |
| messaging/suspend | zig | 6.7 | 1.454 | 1.454 | 48018 | 30.3 | 31.3 KiB |  |  |
| numbers/add | ts | 122.1 | 1.549 | 1.421 | 26030 | 59.5 | 31.4 KiB | 216.0 KiB |  |
| numbers/add | zig | 7.3 | 0.395 | 0.395 | 26030 | 15.2 | 31.4 KiB |  |  |
| numbers/add | applescript |  | 0.230 | 0.227 |  |  |  |  |  |
| numbers/add | gopher-lua |  | 0.0266 | 0.0266 |  |  |  | 43.9 KiB | 177 |
| numbers/divide | ts | 90.5 | 1.290 | 1.195 | 18031 | 71.5 | 31.4 KiB | 333.3 KiB |  |
| numbers/divide | zig | 7.1 | 0.285 | 0.284 | 18031 | 15.8 | 31.4 KiB |  |  |
| numbers/divide | applescript |  | 0.192 | 0.191 |  |  |  |  |  |
| numbers/divide | gopher-lua |  | 0.0199 | 0.0198 |  |  |  | 28.3 KiB | 115 |
| numbers/multiply | ts | 93.8 | 1.084 | 0.990 | 18031 | 60.1 | 31.4 KiB | 218.3 KiB |  |
| numbers/multiply | zig | 7.0 | 0.260 | 0.259 | 18031 | 14.4 | 31.4 KiB |  |  |
| numbers/multiply | applescript |  | 0.174 | 0.174 |  |  |  |  |  |
| numbers/multiply | gopher-lua |  | 0.0182 | 0.0182 |  |  |  | 29.1 KiB | 118 |
| numbers/quantity | ts | 120.2 | 1.260 | 1.131 | 14579 | 86.4 | 39.1 KiB | 272.1 KiB |  |
| numbers/quantity | zig | 8.9 | 0.263 | 0.263 | 14579 | 18.1 | 39.1 KiB |  |  |
| numbers/quantity | applescript |  | 0.122 | 0.118 |  |  |  |  |  |
| numbers/quantity | gopher-lua |  | 0.0115 | 0.0114 |  |  |  | 16.5 KiB | 67 |
| text/build | ts | 80.0 | 0.740 | 0.688 | 28928 | 25.6 | 374.8 KiB | 224.4 KiB |  |
| text/build | zig | 6.1 | 0.0918 | 0.0916 | 28928 | 3.2 | 374.8 KiB |  |  |
| text/build | applescript |  | 0.369 | 0.367 |  |  |  |  |  |
| text/build | gopher-lua |  | 0.0646 | 0.0642 |  |  |  | 400.8 KiB | 1024 |
| text/graphemes | ts | 101.3 | 4.932 | 4.646 | 43518 | 113.3 | 144.1 KiB | 713.3 KiB |  |
| text/graphemes | zig | 8.0 | 0.963 | 0.962 | 43518 | 22.1 | 144.1 KiB |  |  |
| text/index | ts | 112.8 | 2.173 | 2.030 | 26640 | 81.6 | 49.9 KiB | 403.2 KiB |  |
| text/index | zig | 8.0 | 0.584 | 0.583 | 26640 | 21.9 | 49.9 KiB |  |  |
| text/index | applescript |  | 0.919 | 0.906 |  |  |  |  |  |
| text/index | gopher-lua |  | 0.112 | 0.112 |  |  |  | 29.3 KiB | 1055 |
| text/iterate | ts | 93.8 | 2.621 | 2.498 | 30318 | 86.4 | 93.0 KiB | 558.0 KiB |  |
| text/iterate | zig | 7.4 | 0.455 | 0.455 | 30318 | 15.0 | 93.0 KiB |  |  |
| text/iterate | applescript |  | 3.334 | 3.310 |  |  |  |  |  |
| text/iterate | gopher-lua |  | 0.164 | 0.164 |  |  |  | 187.3 KiB | 9847 |
| text/patterns | ts | 123.2 | 5.371 | 5.052 | 13818 | 388.7 | 225.9 KiB | 1.6 MiB |  |
| text/patterns | zig | 7.8 | 0.573 | 0.572 | 13818 | 41.5 | 225.9 KiB |  |  |
| text/patterns | applescript |  | 15.846 | 15.823 |  |  |  |  |  |
| text/patterns | gopher-lua |  | 0.247 | 0.247 |  |  |  | 390.8 KiB | 17736 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- host/pump on zig: 129.1 ns/Fuel, 8.3× the median
- lifecycle/load-small on zig: 127.2 ns/Fuel, 8.2× the median
- text/patterns on ts: 388.7 ns/Fuel, 4.3× the median
- host/suspending on ts: 309.7 ns/Fuel, 3.4× the median
- host/conversion on ts: 304.0 ns/Fuel, 3.4× the median
- host/pump on ts: 871.2 ns/Fuel, 9.6× the median
- messaging/suspend on ts: 345.3 ns/Fuel, 3.8× the median
- lifecycle/load-small on ts: 1096.4 ns/Fuel, 12.1× the median
- lifecycle/rollback on ts: 478.1 ns/Fuel, 5.3× the median

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
