# Benchmark results, 2026-10-15

Commit `f51ad856-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 3, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | ts | 238.1 | 14.415 | 8.201 | 89459 | 161.1 | 195.6 KiB | 1.2 MiB |  |
| collections/iterate | zig | 20.5 | 2.503 | 1.949 | 89459 | 28.0 | 195.6 KiB |  |  |
| collections/iterate | applescript |  | 6.447 | 6.417 |  |  |  |  |  |
| collections/iterate | gopher-lua |  | 0.544 | 0.464 |  |  |  | 108.9 KiB | 6741 |
| collections/list-append | ts | 215.8 | 6.085 | 5.596 | 52056 | 116.9 | 78.3 KiB | 1003.5 KiB |  |
| collections/list-append | zig | 14.4 | 1.453 | 1.241 | 52056 | 27.9 | 78.3 KiB |  |  |
| collections/list-append | applescript |  | 1.424 | 1.414 |  |  |  |  |  |
| collections/list-append | gopher-lua |  | 0.353 | 0.346 |  |  |  | 203.9 KiB | 4315 |
| collections/list-build | ts | 139.7 | 1.413 | 1.293 | 19091 | 74.0 | 2.9 MiB | 173.5 KiB |  |
| collections/list-build | zig | 7.9 | 0.332 | 0.260 | 19091 | 17.4 | 2.9 MiB |  |  |
| collections/list-build | applescript |  | 0.237 | 0.237 |  |  |  |  |  |
| collections/list-build | gopher-lua |  | 0.0717 | 0.0716 |  |  |  | 35.4 KiB | 1045 |
| collections/list-update | ts | 221.1 | 2.882 | 2.570 | 28553 | 100.9 | 23.8 KiB | 391.2 KiB |  |
| collections/list-update | zig | 14.4 | 0.867 | 0.839 | 28553 | 30.4 | 23.8 KiB |  |  |
| collections/list-update | applescript |  | 0.407 | 0.403 |  |  |  |  |  |
| collections/list-update | gopher-lua |  | 0.0471 | 0.0461 |  |  |  | 22.4 KiB | 106 |
| collections/map-build | ts | 194.5 | 1.428 | 1.324 | 14094 | 101.3 | 24.3 KiB | 142.0 KiB |  |
| collections/map-build | zig | 13.3 | 1.286 | 1.177 | 14094 | 91.3 | 24.3 KiB |  |  |
| collections/map-build | applescript |  | 6.398 | 6.304 |  |  |  |  |  |
| collections/map-build | gopher-lua |  | 0.141 | 0.141 |  |  |  | 90.5 KiB | 1291 |
| collections/map-update | ts | 211.3 | 0.986 | 0.895 | 8056 | 122.4 | 12.1 KiB | 79.3 KiB |  |
| collections/map-update | zig | 14.0 | 0.313 | 0.300 | 8056 | 38.9 | 12.1 KiB |  |  |
| collections/map-update | applescript |  | 4.036 | 4.032 |  |  |  |  |  |
| collections/map-update | gopher-lua |  | 0.0295 | 0.0284 |  |  |  | 10.2 KiB | 76 |
| core/calls | ts | 149.0 | 2.538 | 2.241 | 46018 | 55.1 | 31.3 KiB | 101.2 KiB |  |
| core/calls | zig | 10.3 | 0.987 | 0.954 | 46018 | 21.4 | 31.3 KiB |  |  |
| core/calls | applescript |  | 0.671 | 0.651 |  |  |  |  |  |
| core/calls | gopher-lua |  | 0.0835 | 0.0813 |  |  |  | 44.8 KiB | 180 |
| core/fib | ts | 148.8 | 2.904 | 2.262 | 46365 | 62.6 | 46.2 KiB | 139.5 KiB |  |
| core/fib | zig | 14.5 | 1.005 | 0.971 | 46365 | 21.7 | 46.2 KiB |  |  |
| core/fib | applescript |  | 0.530 | 0.522 |  |  |  |  |  |
| core/fib | gopher-lua |  | 0.0798 | 0.0787 |  |  |  | 63 B | 1 |
| core/fib@slice=10 | ts | 108.3 | 17.290 | 11.177 | 46365 | 372.9 | 46.2 KiB | 931.5 KiB |  |
| core/fib@slice=10 | zig | 10.3 | 6.840 | 6.472 | 46365 | 147.5 | 46.2 KiB |  |  |
| core/fib@slice=100 | ts | 94.7 | 3.801 | 3.334 | 46365 | 82.0 | 46.2 KiB | 86.5 KiB |  |
| core/fib@slice=100 | zig | 10.0 | 1.584 | 1.570 | 46365 | 34.2 | 46.2 KiB |  |  |
| core/fib@slice=1000 | ts | 91.3 | 2.678 | 2.472 | 46365 | 57.8 | 46.2 KiB | 10.2 KiB |  |
| core/fib@slice=1000 | zig | 11.5 | 1.109 | 1.039 | 46365 | 23.9 | 46.2 KiB |  |  |
| core/fib@slice=10000 | ts | 87.3 | 2.626 | 2.375 | 46365 | 56.6 | 46.2 KiB | 0 B |  |
| core/fib@slice=10000 | zig | 10.8 | 1.354 | 1.080 | 46365 | 29.2 | 46.2 KiB |  |  |
| core/lambdas | ts | 188.3 | 3.719 | 3.235 | 58027 | 64.1 | 62.6 KiB | 250.9 KiB |  |
| core/lambdas | zig | 12.1 | 1.299 | 1.068 | 58027 | 22.4 | 62.6 KiB |  |  |
| core/lambdas | applescript |  | 0.722 | 0.718 |  |  |  |  |  |
| core/lambdas | gopher-lua |  | 0.120 | 0.114 |  |  |  | 60.3 KiB | 244 |
| core/loop | ts | 160.2 | 4.102 | 3.127 | 48016 | 85.4 | 62.5 KiB | 307.6 KiB |  |
| core/loop | zig | 11.0 | 1.467 | 1.370 | 48016 | 30.5 | 62.5 KiB |  |  |
| core/loop | applescript |  | 0.193 | 0.191 |  |  |  |  |  |
| core/loop | gopher-lua |  | 0.0307 | 0.0306 |  |  |  | 44.8 KiB | 180 |
| host/conversion | ts | 218.6 | 10.612 | 9.904 | 25018 | 424.2 | 220.3 KiB | 1.0 MiB |  |
| host/immediate | ts | 139.1 | 2.340 | 2.129 | 13518 | 173.1 | 15.7 KiB | 307.3 KiB |  |
| host/properties | ts | 122.0 | 1.823 | 1.337 | 9018 | 202.2 | 15.7 KiB | 193.0 KiB |  |
| host/pump | ts | 27.6 | 0.0101 | 0.00885 | 7 | 1440.4 | 0 B | 3.9 KiB |  |
| host/pump | zig | 3.5 | 0.00228 | 0.00222 | 7 | 326.1 | 0 B |  |  |
| host/suspending | ts | 140.6 | 5.091 | 4.335 | 13518 | 376.6 | 15.7 KiB | 123.5 KiB |  |
| lifecycle/load-large | ts | 17043.1 | 0.773 | 0.719 | 4609 | 167.7 | 16.3 KiB | 131 B |  |
| lifecycle/load-large | zig | 1129.0 | 0.234 | 0.230 | 4609 | 50.8 | 16.3 KiB |  |  |
| lifecycle/load-small | ts | 36.8 | 0.00771 | 0.00729 | 7 | 1101.2 | 0 B | 4.0 KiB |  |
| lifecycle/load-small | zig | 4.2 | 0.00232 | 0.00225 | 7 | 332.0 | 0 B |  |  |
| lifecycle/restore | ts | 268.7 | 7.906 | 7.374 | 8015 | 986.4 | 7.8 KiB | 30.7 KiB |  |
| lifecycle/rollback | ts | 270.1 | 53.255 | 50.270 | 102023 | 522.0 | 39.9 KiB | 5.8 KiB |  |
| macro/game-tick | ts | 224.7 | 9.281 | 5.572 | 67042 | 138.4 | 78.4 KiB | 9.4 KiB |  |
| macro/game-tick | zig | 14.3 | 1.965 | 1.652 | 67042 | 29.3 | 78.4 KiB |  |  |
| macro/game-tick | applescript |  | 1.496 | 1.490 |  |  |  |  |  |
| macro/game-tick | gopher-lua |  | 0.151 | 0.150 |  |  |  | 28.7 KiB | 128 |
| macro/report | ts | 123.4 | 2.261 | 2.104 | 86555 | 26.1 | 1.2 MiB | 2.3 MiB |  |
| macro/report | zig | 12.9 | 1.658 | 1.633 | 86555 | 19.2 | 1.2 MiB |  |  |
| macro/report | applescript |  | 3.330 | 3.296 |  |  |  |  |  |
| macro/report | gopher-lua |  | 0.145 | 0.142 |  |  |  | 33.1 KiB | 1291 |
| macro/transform | ts | 199.2 | 3.566 | 3.248 | 20664 | 172.6 | 6.1 MiB | 3.3 KiB |  |
| macro/transform | zig | 16.3 | 0.443 | 0.413 | 20664 | 21.4 | 6.1 MiB |  |  |
| macro/transform | applescript |  | 0.373 | 0.373 |  |  |  |  |  |
| macro/transform | gopher-lua |  | 0.167 | 0.158 |  |  |  | 268.0 KiB | 4538 |
| messaging/joins | ts | 258.5 | 27.345 | 21.805 | 127218 | 214.9 | 239.1 KiB | 5.8 KiB |  |
| messaging/parents | ts | 166.2 | 20.121 | 18.664 | 67518 | 298.0 | 93.8 KiB | 10.0 KiB |  |
| messaging/sends | ts | 185.7 | 16.821 | 13.247 | 67518 | 249.1 | 93.8 KiB | 163.5 KiB |  |
| messaging/suspend | ts | 112.5 | 18.579 | 17.402 | 48018 | 386.9 | 31.3 KiB | 899.9 KiB |  |
| messaging/suspend | zig | 9.2 | 4.265 | 4.238 | 48018 | 88.8 | 31.3 KiB |  |  |
| numbers/add | ts | 113.3 | 2.022 | 1.808 | 26030 | 77.7 | 31.4 KiB | 255.5 KiB |  |
| numbers/add | zig | 8.4 | 0.577 | 0.572 | 26030 | 22.2 | 31.4 KiB |  |  |
| numbers/add | applescript |  | 0.245 | 0.243 |  |  |  |  |  |
| numbers/add | gopher-lua |  | 0.0450 | 0.0378 |  |  |  | 43.9 KiB | 177 |
| numbers/divide | ts | 122.8 | 2.178 | 1.978 | 18031 | 120.8 | 31.4 KiB | 503.0 KiB |  |
| numbers/divide | zig | 9.8 | 0.530 | 0.513 | 18031 | 29.4 | 31.4 KiB |  |  |
| numbers/divide | applescript |  | 0.207 | 0.205 |  |  |  |  |  |
| numbers/divide | gopher-lua |  | 0.0245 | 0.0243 |  |  |  | 28.3 KiB | 115 |
| numbers/multiply | ts | 121.5 | 1.543 | 1.374 | 18031 | 85.5 | 31.4 KiB | 122.3 KiB |  |
| numbers/multiply | zig | 9.6 | 0.470 | 0.422 | 18031 | 26.1 | 31.4 KiB |  |  |
| numbers/multiply | applescript |  | 0.187 | 0.186 |  |  |  |  |  |
| numbers/multiply | gopher-lua |  | 0.0247 | 0.0246 |  |  |  | 29.1 KiB | 118 |
| numbers/quantity | ts | 208.0 | 4.811 | 4.320 | 14579 | 330.0 | 39.1 KiB | 544.4 KiB |  |
| numbers/quantity | zig | 15.5 | 0.602 | 0.593 | 14579 | 41.3 | 39.1 KiB |  |  |
| numbers/quantity | applescript |  | 0.126 | 0.126 |  |  |  |  |  |
| numbers/quantity | gopher-lua |  | 0.0173 | 0.0146 |  |  |  | 16.5 KiB | 67 |
| text/build | ts | 115.7 | 1.089 | 1.012 | 28928 | 37.7 | 374.8 KiB | 169.8 KiB |  |
| text/build | zig | 8.1 | 0.605 | 0.598 | 28928 | 20.9 | 374.8 KiB |  |  |
| text/build | applescript |  | 0.388 | 0.379 |  |  |  |  |  |
| text/build | gopher-lua |  | 0.111 | 0.110 |  |  |  | 400.8 KiB | 1024 |
| text/graphemes | ts | 157.0 | 7.739 | 6.395 | 43518 | 177.8 | 144.1 KiB | 959.3 KiB |  |
| text/graphemes | zig | 10.6 | 1.629 | 1.615 | 43518 | 37.4 | 144.1 KiB |  |  |
| text/index | ts | 172.7 | 11.471 | 7.387 | 26640 | 430.6 | 49.9 KiB | 400.6 KiB |  |
| text/index | zig | 11.9 | 0.951 | 0.917 | 26640 | 35.7 | 49.9 KiB |  |  |
| text/index | applescript |  | 0.951 | 0.940 |  |  |  |  |  |
| text/index | gopher-lua |  | 0.146 | 0.146 |  |  |  | 29.3 KiB | 1055 |
| text/iterate | ts | 143.3 | 4.594 | 4.132 | 30318 | 151.5 | 93.0 KiB | 161.2 KiB |  |
| text/iterate | zig | 10.1 | 0.828 | 0.794 | 30318 | 27.3 | 93.0 KiB |  |  |
| text/iterate | applescript |  | 3.529 | 3.525 |  |  |  |  |  |
| text/iterate | gopher-lua |  | 0.314 | 0.307 |  |  |  | 187.3 KiB | 9847 |
| text/patterns | ts | 158.2 | 9.096 | 6.613 | 13818 | 658.3 | 225.9 KiB | 1.6 MiB |  |
| text/patterns | zig | 11.1 | 0.895 | 0.858 | 13818 | 64.8 | 225.9 KiB |  |  |
| text/patterns | applescript |  | 16.153 | 16.140 |  |  |  |  |  |
| text/patterns | gopher-lua |  | 0.485 | 0.484 |  |  |  | 390.8 KiB | 17736 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- core/fib@slice=10 on zig: 147.5 ns/Fuel, 5.0× the median
- collections/map-build on zig: 91.3 ns/Fuel, 3.1× the median
- host/pump on zig: 326.1 ns/Fuel, 11.1× the median
- messaging/suspend on zig: 88.8 ns/Fuel, 3.0× the median
- lifecycle/load-small on zig: 332.0 ns/Fuel, 11.3× the median
- text/patterns on ts: 658.3 ns/Fuel, 4.2× the median
- host/pump on ts: 1440.4 ns/Fuel, 9.2× the median
- lifecycle/load-small on ts: 1101.2 ns/Fuel, 7.0× the median
- lifecycle/rollback on ts: 522.0 ns/Fuel, 3.3× the median

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
