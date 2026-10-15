# Benchmark results, 2026-10-15

Commit `f51ad856-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 3, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | ts | 244.6 | 7.358 | 6.960 | 89459 | 82.3 | 195.6 KiB | 1.5 MiB |  |
| collections/iterate | zig | 13.6 | 1.737 | 1.664 | 89459 | 19.4 | 195.6 KiB |  |  |
| collections/iterate | applescript |  | 6.404 | 6.341 |  |  |  |  |  |
| collections/iterate | gopher-lua |  | 0.400 | 0.393 |  |  |  | 108.9 KiB | 6741 |
| collections/list-append | ts | 193.3 | 6.434 | 5.226 | 52056 | 123.6 | 78.3 KiB | 1.1 MiB |  |
| collections/list-append | zig | 10.8 | 1.119 | 1.081 | 52056 | 21.5 | 78.3 KiB |  |  |
| collections/list-append | applescript |  | 1.475 | 1.462 |  |  |  |  |  |
| collections/list-append | gopher-lua |  | 0.178 | 0.176 |  |  |  | 203.9 KiB | 4315 |
| collections/list-build | ts | 110.0 | 1.283 | 1.145 | 19091 | 67.2 | 2.9 MiB | 316.4 KiB |  |
| collections/list-build | zig | 7.6 | 0.235 | 0.235 | 19091 | 12.3 | 2.9 MiB |  |  |
| collections/list-build | applescript |  | 0.247 | 0.242 |  |  |  |  |  |
| collections/list-build | gopher-lua |  | 0.0375 | 0.0371 |  |  |  | 35.4 KiB | 1045 |
| collections/list-update | ts | 196.9 | 4.753 | 2.814 | 28553 | 166.5 | 23.8 KiB | 220.6 KiB |  |
| collections/list-update | zig | 12.0 | 0.619 | 0.597 | 28553 | 21.7 | 23.8 KiB |  |  |
| collections/list-update | applescript |  | 0.401 | 0.400 |  |  |  |  |  |
| collections/list-update | gopher-lua |  | 0.0256 | 0.0255 |  |  |  | 22.4 KiB | 106 |
| collections/map-build | ts | 155.0 | 1.250 | 1.057 | 14094 | 88.7 | 24.3 KiB | 197.2 KiB |  |
| collections/map-build | zig | 9.4 | 0.981 | 0.974 | 14094 | 69.6 | 24.3 KiB |  |  |
| collections/map-build | applescript |  | 6.143 | 6.104 |  |  |  |  |  |
| collections/map-build | gopher-lua |  | 0.0791 | 0.0790 |  |  |  | 90.5 KiB | 1291 |
| collections/map-update | ts | 193.3 | 1.066 | 0.921 | 8056 | 132.3 | 12.1 KiB | 262.2 KiB |  |
| collections/map-update | zig | 11.4 | 0.237 | 0.236 | 8056 | 29.4 | 12.1 KiB |  |  |
| collections/map-update | applescript |  | 3.750 | 3.721 |  |  |  |  |  |
| collections/map-update | gopher-lua |  | 0.0185 | 0.0184 |  |  |  | 10.2 KiB | 76 |
| core/calls | ts | 139.9 | 2.693 | 2.422 | 46018 | 58.5 | 31.3 KiB | 135.8 KiB |  |
| core/calls | zig | 7.8 | 0.716 | 0.704 | 46018 | 15.5 | 31.3 KiB |  |  |
| core/calls | applescript |  | 0.665 | 0.658 |  |  |  |  |  |
| core/calls | gopher-lua |  | 0.0799 | 0.0780 |  |  |  | 44.8 KiB | 180 |
| core/fib | ts | 135.7 | 2.392 | 1.842 | 46365 | 51.6 | 46.2 KiB | 203.8 KiB |  |
| core/fib | zig | 7.3 | 0.757 | 0.754 | 46365 | 16.3 | 46.2 KiB |  |  |
| core/fib | applescript |  | 0.528 | 0.524 |  |  |  |  |  |
| core/fib | gopher-lua |  | 0.0803 | 0.0800 |  |  |  | 63 B | 1 |
| core/fib@slice=10 | ts | 99.2 | 11.186 | 9.498 | 46365 | 241.3 | 46.2 KiB | 1.1 MiB |  |
| core/fib@slice=10 | zig | 7.2 | 5.026 | 5.004 | 46365 | 108.4 | 46.2 KiB |  |  |
| core/fib@slice=100 | ts | 83.3 | 2.959 | 2.625 | 46365 | 63.8 | 46.2 KiB | 50.6 KiB |  |
| core/fib@slice=100 | zig | 7.4 | 1.273 | 1.270 | 46365 | 27.4 | 46.2 KiB |  |  |
| core/fib@slice=1000 | ts | 84.0 | 2.209 | 1.995 | 46365 | 47.6 | 46.2 KiB | 2.0 KiB |  |
| core/fib@slice=1000 | zig | 7.7 | 0.806 | 0.806 | 46365 | 17.4 | 46.2 KiB |  |  |
| core/fib@slice=10000 | ts | 84.2 | 2.217 | 2.016 | 46365 | 47.8 | 46.2 KiB | 8.9 KiB |  |
| core/fib@slice=10000 | zig | 7.4 | 0.844 | 0.764 | 46365 | 18.2 | 46.2 KiB |  |  |
| core/lambdas | ts | 179.7 | 4.033 | 3.377 | 58027 | 69.5 | 62.6 KiB | 399.9 KiB |  |
| core/lambdas | zig | 10.2 | 0.941 | 0.940 | 58027 | 16.2 | 62.6 KiB |  |  |
| core/lambdas | applescript |  | 0.716 | 0.709 |  |  |  |  |  |
| core/lambdas | gopher-lua |  | 0.0930 | 0.0930 |  |  |  | 60.3 KiB | 244 |
| core/loop | ts | 109.1 | 2.692 | 2.360 | 48016 | 56.1 | 62.5 KiB | 221.3 KiB |  |
| core/loop | zig | 7.2 | 1.054 | 1.053 | 48016 | 21.9 | 62.5 KiB |  |  |
| core/loop | applescript |  | 0.200 | 0.193 |  |  |  |  |  |
| core/loop | gopher-lua |  | 0.0310 | 0.0292 |  |  |  | 44.8 KiB | 180 |
| host/conversion | ts | 194.5 | 9.811 | 9.192 | 25018 | 392.2 | 220.3 KiB | 3.0 MiB |  |
| host/immediate | ts | 123.8 | 2.184 | 1.980 | 13518 | 161.5 | 15.7 KiB | 79.7 KiB |  |
| host/properties | ts | 116.2 | 2.013 | 1.554 | 9018 | 223.2 | 15.7 KiB | 184.1 KiB |  |
| host/pump | ts | 21.1 | 0.00743 | 0.00699 | 7 | 1061.2 | 0 B | 1.4 KiB |  |
| host/pump | zig | 2.5 | 0.00175 | 0.00173 | 7 | 250.7 | 0 B |  |  |
| host/suspending | ts | 128.4 | 5.016 | 4.327 | 13518 | 371.1 | 15.7 KiB | 403.2 KiB |  |
| lifecycle/load-large | ts | 15827.1 | 0.714 | 0.650 | 4609 | 155.0 | 16.3 KiB | 246 B |  |
| lifecycle/load-large | zig | 788.9 | 0.159 | 0.158 | 4609 | 34.5 | 16.3 KiB |  |  |
| lifecycle/load-small | ts | 34.0 | 0.00729 | 0.00676 | 7 | 1041.4 | 0 B | 2.9 KiB |  |
| lifecycle/load-small | zig | 3.9 | 0.00174 | 0.00173 | 7 | 248.8 | 0 B |  |  |
| lifecycle/restore | ts | 246.8 | 7.581 | 6.983 | 8015 | 945.8 | 7.8 KiB | 142.2 KiB |  |
| lifecycle/rollback | ts | 268.8 | 70.864 | 65.788 | 102023 | 694.6 | 39.9 KiB | 13.1 KiB |  |
| macro/game-tick | ts | 213.3 | 6.049 | 5.697 | 67042 | 90.2 | 78.4 KiB | 5.6 KiB |  |
| macro/game-tick | zig | 13.0 | 1.598 | 1.504 | 67042 | 23.8 | 78.4 KiB |  |  |
| macro/game-tick | applescript |  | 1.560 | 1.555 |  |  |  |  |  |
| macro/game-tick | gopher-lua |  | 0.139 | 0.138 |  |  |  | 28.7 KiB | 128 |
| macro/report | ts | 125.2 | 2.109 | 1.990 | 86555 | 24.4 | 1.2 MiB | 2.4 MiB |  |
| macro/report | zig | 7.8 | 1.237 | 1.233 | 86555 | 14.3 | 1.2 MiB |  |  |
| macro/report | applescript |  | 4.388 | 3.578 |  |  |  |  |  |
| macro/report | gopher-lua |  | 0.134 | 0.134 |  |  |  | 33.1 KiB | 1291 |
| macro/transform | ts | 170.4 | 3.244 | 3.086 | 20664 | 157.0 | 6.1 MiB | 1.3 KiB |  |
| macro/transform | zig | 11.5 | 0.327 | 0.326 | 20664 | 15.8 | 6.1 MiB |  |  |
| macro/transform | applescript |  | 0.382 | 0.370 |  |  |  |  |  |
| macro/transform | gopher-lua |  | 0.143 | 0.142 |  |  |  | 268.0 KiB | 4538 |
| messaging/joins | ts | 239.6 | 21.231 | 20.207 | 127218 | 166.9 | 239.1 KiB | 6.4 KiB |  |
| messaging/parents | ts | 160.7 | 15.556 | 14.640 | 67518 | 230.4 | 93.8 KiB | 638.4 KiB |  |
| messaging/sends | ts | 190.2 | 17.305 | 16.113 | 67518 | 256.3 | 93.8 KiB | 265.6 KiB |  |
| messaging/suspend | ts | 107.5 | 18.447 | 16.499 | 48018 | 384.2 | 31.3 KiB | 16.0 KiB |  |
| messaging/suspend | zig | 6.5 | 2.970 | 2.950 | 48018 | 61.8 | 31.3 KiB |  |  |
| numbers/add | ts | 123.3 | 2.430 | 2.204 | 26030 | 93.3 | 31.4 KiB | 271.9 KiB |  |
| numbers/add | zig | 7.0 | 0.530 | 0.523 | 26030 | 20.4 | 31.4 KiB |  |  |
| numbers/add | applescript |  | 0.242 | 0.240 |  |  |  |  |  |
| numbers/add | gopher-lua |  | 0.0291 | 0.0291 |  |  |  | 43.9 KiB | 177 |
| numbers/divide | ts | 92.1 | 2.166 | 1.992 | 18031 | 120.1 | 31.4 KiB | 507.3 KiB |  |
| numbers/divide | zig | 7.0 | 0.441 | 0.369 | 18031 | 24.4 | 31.4 KiB |  |  |
| numbers/divide | applescript |  | 0.203 | 0.201 |  |  |  |  |  |
| numbers/divide | gopher-lua |  | 0.0218 | 0.0216 |  |  |  | 28.3 KiB | 115 |
| numbers/multiply | ts | 101.4 | 1.526 | 1.363 | 18031 | 84.6 | 31.4 KiB | 147.3 KiB |  |
| numbers/multiply | zig | 7.1 | 0.351 | 0.348 | 18031 | 19.5 | 31.4 KiB |  |  |
| numbers/multiply | applescript |  | 0.184 | 0.183 |  |  |  |  |  |
| numbers/multiply | gopher-lua |  | 0.0206 | 0.0201 |  |  |  | 29.1 KiB | 118 |
| numbers/quantity | ts | 165.5 | 4.318 | 3.980 | 14579 | 296.2 | 39.1 KiB | 350.9 KiB |  |
| numbers/quantity | zig | 8.7 | 0.409 | 0.408 | 14579 | 28.1 | 39.1 KiB |  |  |
| numbers/quantity | applescript |  | 0.126 | 0.125 |  |  |  |  |  |
| numbers/quantity | gopher-lua |  | 0.0123 | 0.0123 |  |  |  | 16.5 KiB | 67 |
| text/build | ts | 103.7 | 1.138 | 1.047 | 28928 | 39.3 | 374.8 KiB | 150.3 KiB |  |
| text/build | zig | 6.1 | 0.435 | 0.435 | 28928 | 15.1 | 374.8 KiB |  |  |
| text/build | applescript |  | 0.380 | 0.380 |  |  |  |  |  |
| text/build | gopher-lua |  | 0.0779 | 0.0698 |  |  |  | 400.8 KiB | 1024 |
| text/graphemes | ts | 133.3 | 5.762 | 5.244 | 43518 | 132.4 | 144.1 KiB | 1.0 MiB |  |
| text/graphemes | zig | 8.1 | 1.165 | 1.165 | 43518 | 26.8 | 144.1 KiB |  |  |
| text/index | ts | 146.5 | 7.416 | 6.687 | 26640 | 278.4 | 49.9 KiB | 732.3 KiB |  |
| text/index | zig | 8.1 | 0.711 | 0.706 | 26640 | 26.7 | 49.9 KiB |  |  |
| text/index | applescript |  | 0.934 | 0.930 |  |  |  |  |  |
| text/index | gopher-lua |  | 0.113 | 0.113 |  |  |  | 29.3 KiB | 1055 |
| text/iterate | ts | 118.8 | 3.761 | 3.451 | 30318 | 124.1 | 93.0 KiB | 1.1 MiB |  |
| text/iterate | zig | 7.2 | 0.665 | 0.614 | 30318 | 21.9 | 93.0 KiB |  |  |
| text/iterate | applescript |  | 3.590 | 3.551 |  |  |  |  |  |
| text/iterate | gopher-lua |  | 0.182 | 0.179 |  |  |  | 187.3 KiB | 9847 |
| text/patterns | ts | 144.8 | 6.083 | 5.703 | 13818 | 440.3 | 225.9 KiB | 1.3 MiB |  |
| text/patterns | zig | 8.5 | 0.599 | 0.599 | 13818 | 43.4 | 225.9 KiB |  |  |
| text/patterns | applescript |  | 16.083 | 16.000 |  |  |  |  |  |
| text/patterns | gopher-lua |  | 0.247 | 0.247 |  |  |  | 390.8 KiB | 17736 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- core/fib@slice=10 on zig: 108.4 ns/Fuel, 4.9× the median
- collections/map-build on zig: 69.6 ns/Fuel, 3.2× the median
- host/pump on zig: 250.7 ns/Fuel, 11.4× the median
- lifecycle/load-small on zig: 248.8 ns/Fuel, 11.3× the median
- text/patterns on ts: 440.3 ns/Fuel, 3.3× the median
- host/pump on ts: 1061.2 ns/Fuel, 8.0× the median
- lifecycle/load-small on ts: 1041.4 ns/Fuel, 7.9× the median
- lifecycle/rollback on ts: 694.6 ns/Fuel, 5.2× the median

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
