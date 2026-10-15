# Benchmark results, 2026-10-15

Commit `f51ad856-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 3, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | ts | 251.6 | 12.736 | 7.761 | 89459 | 142.4 | 195.6 KiB | 1.9 MiB |  |
| collections/iterate | zig | 14.3 | 1.718 | 1.715 | 89459 | 19.2 | 195.6 KiB |  |  |
| collections/iterate | applescript |  | 6.512 | 6.510 |  |  |  |  |  |
| collections/iterate | gopher-lua |  | 0.430 | 0.429 |  |  |  | 108.9 KiB | 6741 |
| collections/list-append | ts | 187.3 | 5.803 | 5.351 | 52056 | 111.5 | 78.3 KiB | 917.3 KiB |  |
| collections/list-append | zig | 10.5 | 1.100 | 1.092 | 52056 | 21.1 | 78.3 KiB |  |  |
| collections/list-append | applescript |  | 1.479 | 1.458 |  |  |  |  |  |
| collections/list-append | gopher-lua |  | 0.194 | 0.194 |  |  |  | 203.9 KiB | 4315 |
| collections/list-build | ts | 115.4 | 1.325 | 1.233 | 19091 | 69.4 | 2.9 MiB | 162.6 KiB |  |
| collections/list-build | zig | 7.6 | 0.247 | 0.244 | 19091 | 12.9 | 2.9 MiB |  |  |
| collections/list-build | applescript |  | 0.242 | 0.240 |  |  |  |  |  |
| collections/list-build | gopher-lua |  | 0.0408 | 0.0406 |  |  |  | 35.4 KiB | 1045 |
| collections/list-update | ts | 198.4 | 3.967 | 3.661 | 28553 | 138.9 | 23.8 KiB | 529.9 KiB |  |
| collections/list-update | zig | 11.0 | 0.621 | 0.620 | 28553 | 21.8 | 23.8 KiB |  |  |
| collections/list-update | applescript |  | 0.403 | 0.392 |  |  |  |  |  |
| collections/list-update | gopher-lua |  | 0.0282 | 0.0281 |  |  |  | 22.4 KiB | 106 |
| collections/map-build | ts | 149.0 | 1.358 | 1.259 | 14094 | 96.3 | 24.3 KiB | 267.2 KiB |  |
| collections/map-build | zig | 9.6 | 0.996 | 0.989 | 14094 | 70.7 | 24.3 KiB |  |  |
| collections/map-build | applescript |  | 6.095 | 6.080 |  |  |  |  |  |
| collections/map-build | gopher-lua |  | 0.0860 | 0.0859 |  |  |  | 90.5 KiB | 1291 |
| collections/map-update | ts | 181.4 | 1.070 | 0.980 | 8056 | 132.9 | 12.1 KiB | 147.7 KiB |  |
| collections/map-update | zig | 11.8 | 0.241 | 0.240 | 8056 | 29.9 | 12.1 KiB |  |  |
| collections/map-update | applescript |  | 3.765 | 3.729 |  |  |  |  |  |
| collections/map-update | gopher-lua |  | 0.0206 | 0.0202 |  |  |  | 10.2 KiB | 76 |
| core/calls | ts | 152.2 | 3.110 | 2.840 | 46018 | 67.6 | 31.3 KiB | 219.3 KiB |  |
| core/calls | zig | 7.8 | 0.717 | 0.713 | 46018 | 15.6 | 31.3 KiB |  |  |
| core/calls | applescript |  | 0.659 | 0.653 |  |  |  |  |  |
| core/calls | gopher-lua |  | 0.0803 | 0.0799 |  |  |  | 44.8 KiB | 180 |
| core/fib | ts | 141.0 | 2.769 | 2.213 | 46365 | 59.7 | 46.2 KiB | 237.6 KiB |  |
| core/fib | zig | 7.2 | 0.738 | 0.737 | 46365 | 15.9 | 46.2 KiB |  |  |
| core/fib | applescript |  | 0.515 | 0.503 |  |  |  |  |  |
| core/fib | gopher-lua |  | 0.0794 | 0.0793 |  |  |  | 63 B | 1 |
| core/fib@slice=10 | ts | 104.4 | 13.074 | 11.111 | 46365 | 282.0 | 46.2 KiB | 475.2 KiB |  |
| core/fib@slice=10 | zig | 7.3 | 5.012 | 4.872 | 46365 | 108.1 | 46.2 KiB |  |  |
| core/fib@slice=100 | ts | 91.8 | 3.766 | 3.235 | 46365 | 81.2 | 46.2 KiB | 51.2 KiB |  |
| core/fib@slice=100 | zig | 7.3 | 1.201 | 1.193 | 46365 | 25.9 | 46.2 KiB |  |  |
| core/fib@slice=1000 | ts | 91.2 | 2.628 | 2.408 | 46365 | 56.7 | 46.2 KiB | 43.4 KiB |  |
| core/fib@slice=1000 | zig | 7.3 | 0.810 | 0.803 | 46365 | 17.5 | 46.2 KiB |  |  |
| core/fib@slice=10000 | ts | 90.3 | 2.498 | 2.308 | 46365 | 53.9 | 46.2 KiB | 7.6 KiB |  |
| core/fib@slice=10000 | zig | 7.2 | 0.787 | 0.784 | 46365 | 17.0 | 46.2 KiB |  |  |
| core/lambdas | ts | 184.5 | 4.383 | 3.917 | 58027 | 75.5 | 62.6 KiB | 394.6 KiB |  |
| core/lambdas | zig | 9.0 | 0.941 | 0.939 | 58027 | 16.2 | 62.6 KiB |  |  |
| core/lambdas | applescript |  | 0.694 | 0.693 |  |  |  |  |  |
| core/lambdas | gopher-lua |  | 0.0997 | 0.0974 |  |  |  | 60.3 KiB | 244 |
| core/loop | ts | 113.2 | 3.389 | 2.985 | 48016 | 70.6 | 62.5 KiB | 309.8 KiB |  |
| core/loop | zig | 6.8 | 1.105 | 1.055 | 48016 | 23.0 | 62.5 KiB |  |  |
| core/loop | applescript |  | 0.192 | 0.192 |  |  |  |  |  |
| core/loop | gopher-lua |  | 0.0293 | 0.0290 |  |  |  | 44.8 KiB | 180 |
| host/conversion | ts | 185.0 | 9.782 | 9.433 | 25018 | 391.0 | 220.3 KiB | 622.1 KiB |  |
| host/immediate | ts | 121.2 | 2.216 | 2.084 | 13518 | 164.0 | 15.7 KiB | 173.1 KiB |  |
| host/properties | ts | 112.7 | 2.047 | 1.546 | 9018 | 227.0 | 15.7 KiB | 150.7 KiB |  |
| host/pump | ts | 21.1 | 0.00712 | 0.00668 | 7 | 1017.3 | 0 B | 3.4 KiB |  |
| host/pump | zig | 2.5 | 0.00180 | 0.00178 | 7 | 257.6 | 0 B |  |  |
| host/suspending | ts | 129.6 | 5.032 | 4.289 | 13518 | 372.2 | 15.7 KiB | 675.5 KiB |  |
| lifecycle/load-large | ts | 17418.2 | 0.710 | 0.659 | 4609 | 154.1 | 16.3 KiB | 280 B |  |
| lifecycle/load-large | zig | 820.2 | 0.163 | 0.162 | 4609 | 35.4 | 16.3 KiB |  |  |
| lifecycle/load-small | ts | 34.2 | 0.00747 | 0.00699 | 7 | 1067.0 | 0 B | 3.3 KiB |  |
| lifecycle/load-small | zig | 3.2 | 0.00183 | 0.00181 | 7 | 261.3 | 0 B |  |  |
| lifecycle/restore | ts | 254.2 | 8.357 | 7.548 | 8015 | 1042.6 | 7.8 KiB | 59.1 KiB |  |
| lifecycle/rollback | ts | 275.5 | 69.610 | 65.373 | 102023 | 682.3 | 39.9 KiB | 9.3 KiB |  |
| macro/game-tick | ts | 215.0 | 6.357 | 5.816 | 67042 | 94.8 | 78.4 KiB | 5.1 KiB |  |
| macro/game-tick | zig | 13.3 | 1.488 | 1.483 | 67042 | 22.2 | 78.4 KiB |  |  |
| macro/game-tick | applescript |  | 1.560 | 1.451 |  |  |  |  |  |
| macro/game-tick | gopher-lua |  | 0.139 | 0.139 |  |  |  | 28.7 KiB | 128 |
| macro/report | ts | 123.3 | 2.251 | 2.110 | 86555 | 26.0 | 1.2 MiB | 2.3 MiB |  |
| macro/report | zig | 8.1 | 1.239 | 1.237 | 86555 | 14.3 | 1.2 MiB |  |  |
| macro/report | applescript |  | 3.238 | 3.207 |  |  |  |  |  |
| macro/report | gopher-lua |  | 0.134 | 0.133 |  |  |  | 33.1 KiB | 1291 |
| macro/transform | ts | 173.6 | 3.357 | 3.109 | 20664 | 162.4 | 6.1 MiB | 1.4 KiB |  |
| macro/transform | zig | 11.5 | 0.325 | 0.322 | 20664 | 15.7 | 6.1 MiB |  |  |
| macro/transform | applescript |  | 0.362 | 0.358 |  |  |  |  |  |
| macro/transform | gopher-lua |  | 0.134 | 0.134 |  |  |  | 268.0 KiB | 4538 |
| messaging/joins | ts | 242.7 | 21.563 | 20.668 | 127218 | 169.5 | 239.1 KiB | 68.8 KiB |  |
| messaging/parents | ts | 161.2 | 16.598 | 15.467 | 67518 | 245.8 | 93.8 KiB | 396.6 KiB |  |
| messaging/sends | ts | 184.8 | 18.345 | 16.421 | 67518 | 271.7 | 93.8 KiB | 222.3 KiB |  |
| messaging/suspend | ts | 105.7 | 17.895 | 17.145 | 48018 | 372.7 | 31.3 KiB | 16.0 KiB |  |
| messaging/suspend | zig | 7.5 | 3.103 | 3.072 | 48018 | 64.6 | 31.3 KiB |  |  |
| numbers/add | ts | 130.5 | 2.754 | 2.529 | 26030 | 105.8 | 31.4 KiB | 128.2 KiB |  |
| numbers/add | zig | 6.7 | 0.520 | 0.515 | 26030 | 20.0 | 31.4 KiB |  |  |
| numbers/add | applescript |  | 0.237 | 0.236 |  |  |  |  |  |
| numbers/add | gopher-lua |  | 0.0314 | 0.0305 |  |  |  | 43.9 KiB | 177 |
| numbers/divide | ts | 93.7 | 2.116 | 1.991 | 18031 | 117.3 | 31.4 KiB | 428.1 KiB |  |
| numbers/divide | zig | 6.9 | 0.365 | 0.365 | 18031 | 20.3 | 31.4 KiB |  |  |
| numbers/divide | applescript |  | 0.210 | 0.200 |  |  |  |  |  |
| numbers/divide | gopher-lua |  | 0.0232 | 0.0219 |  |  |  | 28.3 KiB | 115 |
| numbers/multiply | ts | 121.1 | 1.730 | 1.604 | 18031 | 96.0 | 31.4 KiB | 285.0 KiB |  |
| numbers/multiply | zig | 7.0 | 0.352 | 0.335 | 18031 | 19.5 | 31.4 KiB |  |  |
| numbers/multiply | applescript |  | 0.179 | 0.179 |  |  |  |  |  |
| numbers/multiply | gopher-lua |  | 0.0221 | 0.0211 |  |  |  | 29.1 KiB | 118 |
| numbers/quantity | ts | 154.4 | 4.110 | 3.865 | 14579 | 281.9 | 39.1 KiB | 288.5 KiB |  |
| numbers/quantity | zig | 8.4 | 0.404 | 0.403 | 14579 | 27.7 | 39.1 KiB |  |  |
| numbers/quantity | applescript |  | 0.125 | 0.124 |  |  |  |  |  |
| numbers/quantity | gopher-lua |  | 0.0144 | 0.0133 |  |  |  | 16.5 KiB | 67 |
| text/build | ts | 95.8 | 1.093 | 1.045 | 28928 | 37.8 | 374.8 KiB | 121.7 KiB |  |
| text/build | zig | 5.9 | 0.439 | 0.438 | 28928 | 15.2 | 374.8 KiB |  |  |
| text/build | applescript |  | 0.381 | 0.378 |  |  |  |  |  |
| text/build | gopher-lua |  | 0.0710 | 0.0703 |  |  |  | 400.8 KiB | 1024 |
| text/graphemes | ts | 119.5 | 5.861 | 5.415 | 43518 | 134.7 | 144.1 KiB | 1.1 MiB |  |
| text/graphemes | zig | 7.9 | 1.152 | 1.146 | 43518 | 26.5 | 144.1 KiB |  |  |
| text/index | ts | 131.9 | 3.971 | 3.780 | 26640 | 149.1 | 49.9 KiB | 526.8 KiB |  |
| text/index | zig | 8.0 | 0.691 | 0.690 | 26640 | 25.9 | 49.9 KiB |  |  |
| text/index | applescript |  | 0.960 | 0.948 |  |  |  |  |  |
| text/index | gopher-lua |  | 0.125 | 0.119 |  |  |  | 29.3 KiB | 1055 |
| text/iterate | ts | 112.3 | 3.495 | 3.255 | 30318 | 115.3 | 93.0 KiB | 998.9 KiB |  |
| text/iterate | zig | 7.1 | 0.645 | 0.607 | 30318 | 21.3 | 93.0 KiB |  |  |
| text/iterate | applescript |  | 3.631 | 3.607 |  |  |  |  |  |
| text/iterate | gopher-lua |  | 0.179 | 0.178 |  |  |  | 187.3 KiB | 9847 |
| text/patterns | ts | 129.6 | 6.225 | 5.567 | 13818 | 450.5 | 225.9 KiB | 1.6 MiB |  |
| text/patterns | zig | 7.5 | 0.608 | 0.607 | 13818 | 44.0 | 225.9 KiB |  |  |
| text/patterns | applescript |  | 16.694 | 16.517 |  |  |  |  |  |
| text/patterns | gopher-lua |  | 0.280 | 0.275 |  |  |  | 390.8 KiB | 17736 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- core/fib@slice=10 on zig: 108.1 ns/Fuel, 5.0× the median
- collections/map-build on zig: 70.7 ns/Fuel, 3.3× the median
- host/pump on zig: 257.6 ns/Fuel, 12.0× the median
- messaging/suspend on zig: 64.6 ns/Fuel, 3.0× the median
- lifecycle/load-small on zig: 261.3 ns/Fuel, 12.1× the median
- text/patterns on ts: 450.5 ns/Fuel, 3.3× the median
- host/pump on ts: 1017.3 ns/Fuel, 7.4× the median
- lifecycle/load-small on ts: 1067.0 ns/Fuel, 7.8× the median
- lifecycle/rollback on ts: 682.3 ns/Fuel, 5.0× the median

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
