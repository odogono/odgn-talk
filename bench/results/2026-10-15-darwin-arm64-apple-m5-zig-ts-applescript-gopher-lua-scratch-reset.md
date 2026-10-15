# Benchmark results, 2026-10-15

Commit `0aed90d3-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 3, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | ts | 198.6 | 6.308 | 5.903 | 89459 | 70.5 | 195.6 KiB | 418.7 KiB |  |
| collections/iterate | zig | 14.3 | 1.368 | 1.366 | 89459 | 15.3 | 195.6 KiB |  |  |
| collections/iterate | applescript |  | 6.661 | 6.594 |  |  |  |  |  |
| collections/iterate | gopher-lua |  | 0.429 | 0.417 |  |  |  | 108.9 KiB | 6741 |
| collections/list-append | ts | 192.6 | 4.930 | 4.354 | 52056 | 94.7 | 78.3 KiB | 738.3 KiB |  |
| collections/list-append | zig | 10.4 | 0.866 | 0.864 | 52056 | 16.6 | 78.3 KiB |  |  |
| collections/list-append | applescript |  | 1.534 | 1.486 |  |  |  |  |  |
| collections/list-append | gopher-lua |  | 0.202 | 0.197 |  |  |  | 203.9 KiB | 4315 |
| collections/list-build | ts | 116.0 | 1.048 | 0.986 | 19091 | 54.9 | 2.9 MiB | 315.3 KiB |  |
| collections/list-build | zig | 7.5 | 0.189 | 0.189 | 19091 | 9.9 | 2.9 MiB |  |  |
| collections/list-build | applescript |  | 0.247 | 0.247 |  |  |  |  |  |
| collections/list-build | gopher-lua |  | 0.0419 | 0.0418 |  |  |  | 35.4 KiB | 1045 |
| collections/list-update | ts | 200.9 | 3.952 | 2.238 | 28553 | 138.4 | 23.8 KiB | 478.1 KiB |  |
| collections/list-update | zig | 10.5 | 0.506 | 0.504 | 28553 | 17.7 | 23.8 KiB |  |  |
| collections/list-update | applescript |  | 0.409 | 0.406 |  |  |  |  |  |
| collections/list-update | gopher-lua |  | 0.0291 | 0.0290 |  |  |  | 22.4 KiB | 106 |
| collections/map-build | ts | 149.7 | 1.107 | 1.055 | 14094 | 78.6 | 24.3 KiB | 251.4 KiB |  |
| collections/map-build | zig | 9.5 | 0.904 | 0.894 | 14094 | 64.1 | 24.3 KiB |  |  |
| collections/map-build | applescript |  | 6.260 | 6.204 |  |  |  |  |  |
| collections/map-build | gopher-lua |  | 0.0899 | 0.0896 |  |  |  | 90.5 KiB | 1291 |
| collections/map-update | ts | 178.5 | 0.818 | 0.737 | 8056 | 101.6 | 12.1 KiB | 137.2 KiB |  |
| collections/map-update | zig | 11.6 | 0.203 | 0.202 | 8056 | 25.1 | 12.1 KiB |  |  |
| collections/map-update | applescript |  | 3.791 | 3.757 |  |  |  |  |  |
| collections/map-update | gopher-lua |  | 0.0215 | 0.0206 |  |  |  | 10.2 KiB | 76 |
| core/calls | ts | 138.0 | 1.994 | 1.810 | 46018 | 43.3 | 31.3 KiB | 147.6 KiB |  |
| core/calls | zig | 8.1 | 0.620 | 0.577 | 46018 | 13.5 | 31.3 KiB |  |  |
| core/calls | applescript |  | 0.682 | 0.676 |  |  |  |  |  |
| core/calls | gopher-lua |  | 0.0821 | 0.0804 |  |  |  | 44.8 KiB | 180 |
| core/fib | ts | 137.6 | 2.302 | 1.816 | 46365 | 49.6 | 46.2 KiB | 176.8 KiB |  |
| core/fib | zig | 7.2 | 0.576 | 0.575 | 46365 | 12.4 | 46.2 KiB |  |  |
| core/fib | applescript |  | 0.534 | 0.525 |  |  |  |  |  |
| core/fib | gopher-lua |  | 0.0803 | 0.0802 |  |  |  | 63 B | 1 |
| core/fib@slice=10 | ts | 99.1 | 10.502 | 9.486 | 46365 | 226.5 | 46.2 KiB | 604.5 KiB |  |
| core/fib@slice=10 | zig | 7.2 | 4.660 | 4.552 | 46365 | 100.5 | 46.2 KiB |  |  |
| core/fib@slice=100 | ts | 84.9 | 2.948 | 2.689 | 46365 | 63.6 | 46.2 KiB | 31.6 KiB |  |
| core/fib@slice=100 | zig | 7.2 | 1.006 | 0.998 | 46365 | 21.7 | 46.2 KiB |  |  |
| core/fib@slice=1000 | ts | 82.9 | 2.099 | 1.965 | 46365 | 45.3 | 46.2 KiB | 34.1 KiB |  |
| core/fib@slice=1000 | zig | 7.2 | 0.627 | 0.627 | 46365 | 13.5 | 46.2 KiB |  |  |
| core/fib@slice=10000 | ts | 83.6 | 2.045 | 1.897 | 46365 | 44.1 | 46.2 KiB | 14.1 KiB |  |
| core/fib@slice=10000 | zig | 7.2 | 0.619 | 0.593 | 46365 | 13.4 | 46.2 KiB |  |  |
| core/lambdas | ts | 170.2 | 2.946 | 2.606 | 58027 | 50.8 | 62.6 KiB | 396.1 KiB |  |
| core/lambdas | zig | 9.6 | 0.782 | 0.767 | 58027 | 13.5 | 62.6 KiB |  |  |
| core/lambdas | applescript |  | 0.751 | 0.749 |  |  |  |  |  |
| core/lambdas | gopher-lua |  | 0.0965 | 0.0959 |  |  |  | 60.3 KiB | 244 |
| core/loop | ts | 114.6 | 2.811 | 2.476 | 48016 | 58.5 | 62.5 KiB | 356.3 KiB |  |
| core/loop | zig | 6.8 | 0.818 | 0.808 | 48016 | 17.0 | 62.5 KiB |  |  |
| core/loop | applescript |  | 0.203 | 0.199 |  |  |  |  |  |
| core/loop | gopher-lua |  | 0.0295 | 0.0295 |  |  |  | 44.8 KiB | 180 |
| host/conversion | ts | 173.8 | 8.999 | 8.585 | 25018 | 359.7 | 220.3 KiB | 1003.9 KiB |  |
| host/immediate | ts | 113.5 | 2.245 | 1.910 | 13518 | 166.1 | 15.7 KiB | 252.6 KiB |  |
| host/properties | ts | 110.0 | 1.984 | 1.724 | 9018 | 220.0 | 15.7 KiB | 98.2 KiB |  |
| host/pump | ts | 20.2 | 0.00684 | 0.00637 | 7 | 976.6 | 0 B | 2.6 KiB |  |
| host/pump | zig | 3.0 | 0.00169 | 0.00168 | 7 | 242.1 | 0 B |  |  |
| host/suspending | ts | 116.7 | 4.876 | 4.235 | 13518 | 360.7 | 15.7 KiB | 262.8 KiB |  |
| lifecycle/load-large | ts | 16393.5 | 0.684 | 0.641 | 4609 | 148.3 | 16.3 KiB | 150 B |  |
| lifecycle/load-large | zig | 809.4 | 0.145 | 0.145 | 4609 | 31.5 | 16.3 KiB |  |  |
| lifecycle/load-small | ts | 31.7 | 0.00721 | 0.00663 | 7 | 1030.1 | 0 B | 292 B |  |
| lifecycle/load-small | zig | 2.9 | 0.00169 | 0.00167 | 7 | 241.0 | 0 B |  |  |
| lifecycle/restore | ts | 256.7 | 7.432 | 7.090 | 8015 | 927.3 | 7.8 KiB | 62.0 KiB |  |
| lifecycle/rollback | ts | 282.5 | 49.643 | 48.636 | 102023 | 486.6 | 39.9 KiB | 5.8 KiB |  |
| macro/game-tick | ts | 198.0 | 5.120 | 4.861 | 67042 | 76.4 | 78.4 KiB | 22.5 KiB |  |
| macro/game-tick | zig | 13.5 | 1.259 | 1.247 | 67042 | 18.8 | 78.4 KiB |  |  |
| macro/game-tick | applescript |  | 1.507 | 1.494 |  |  |  |  |  |
| macro/game-tick | gopher-lua |  | 0.133 | 0.132 |  |  |  | 28.7 KiB | 128 |
| macro/report | ts | 114.7 | 1.585 | 1.463 | 86555 | 18.3 | 1.2 MiB | 2.4 MiB |  |
| macro/report | zig | 8.0 | 1.230 | 1.222 | 86555 | 14.2 | 1.2 MiB |  |  |
| macro/report | applescript |  | 3.600 | 3.538 |  |  |  |  |  |
| macro/report | gopher-lua |  | 0.131 | 0.130 |  |  |  | 33.1 KiB | 1291 |
| macro/transform | ts | 165.0 | 1.995 | 1.840 | 20664 | 96.6 | 6.1 MiB | 22.9 KiB |  |
| macro/transform | zig | 11.4 | 0.274 | 0.270 | 20664 | 13.3 | 6.1 MiB |  |  |
| macro/transform | applescript |  | 0.373 | 0.373 |  |  |  |  |  |
| macro/transform | gopher-lua |  | 0.130 | 0.129 |  |  |  | 268.0 KiB | 4538 |
| messaging/joins | ts | 232.3 | 20.396 | 17.713 | 127218 | 160.3 | 239.1 KiB | 4.8 KiB |  |
| messaging/parents | ts | 147.3 | 13.737 | 13.244 | 67518 | 203.5 | 93.8 KiB | 125.7 KiB |  |
| messaging/sends | ts | 165.6 | 14.847 | 14.258 | 67518 | 219.9 | 93.8 KiB | 188.1 KiB |  |
| messaging/suspend | ts | 98.3 | 14.674 | 14.173 | 48018 | 305.6 | 31.3 KiB | 0 B |  |
| messaging/suspend | zig | 6.8 | 2.833 | 2.809 | 48018 | 59.0 | 31.3 KiB |  |  |
| numbers/add | ts | 138.3 | 1.712 | 1.588 | 26030 | 65.8 | 31.4 KiB | 133.3 KiB |  |
| numbers/add | zig | 6.9 | 0.413 | 0.410 | 26030 | 15.9 | 31.4 KiB |  |  |
| numbers/add | applescript |  | 0.254 | 0.250 |  |  |  |  |  |
| numbers/add | gopher-lua |  | 0.0307 | 0.0305 |  |  |  | 43.9 KiB | 177 |
| numbers/divide | ts | 96.3 | 1.413 | 1.291 | 18031 | 78.4 | 31.4 KiB | 278.0 KiB |  |
| numbers/divide | zig | 7.1 | 0.305 | 0.302 | 18031 | 16.9 | 31.4 KiB |  |  |
| numbers/divide | applescript |  | 0.207 | 0.207 |  |  |  |  |  |
| numbers/divide | gopher-lua |  | 0.0228 | 0.0227 |  |  |  | 28.3 KiB | 115 |
| numbers/multiply | ts | 132.4 | 1.186 | 1.093 | 18031 | 65.8 | 31.4 KiB | 208.2 KiB |  |
| numbers/multiply | zig | 7.1 | 0.261 | 0.260 | 18031 | 14.4 | 31.4 KiB |  |  |
| numbers/multiply | applescript |  | 0.190 | 0.189 |  |  |  |  |  |
| numbers/multiply | gopher-lua |  | 0.0212 | 0.0211 |  |  |  | 29.1 KiB | 118 |
| numbers/quantity | ts | 128.7 | 1.327 | 1.190 | 14579 | 91.0 | 39.1 KiB | 280.5 KiB |  |
| numbers/quantity | zig | 18.9 | 0.284 | 0.280 | 14579 | 19.5 | 39.1 KiB |  |  |
| numbers/quantity | applescript |  | 0.125 | 0.124 |  |  |  |  |  |
| numbers/quantity | gopher-lua |  | 0.0132 | 0.0130 |  |  |  | 16.5 KiB | 67 |
| text/build | ts | 80.5 | 0.752 | 0.706 | 28928 | 26.0 | 374.8 KiB | 199.4 KiB |  |
| text/build | zig | 6.2 | 0.645 | 0.545 | 28928 | 22.3 | 374.8 KiB |  |  |
| text/build | applescript |  | 0.384 | 0.382 |  |  |  |  |  |
| text/build | gopher-lua |  | 0.0825 | 0.0816 |  |  |  | 400.8 KiB | 1024 |
| text/graphemes | ts | 102.6 | 5.064 | 4.825 | 43518 | 116.4 | 144.1 KiB | 383.2 KiB |  |
| text/graphemes | zig | 7.9 | 1.023 | 0.997 | 43518 | 23.5 | 144.1 KiB |  |  |
| text/index | ts | 112.2 | 2.219 | 2.044 | 26640 | 83.3 | 49.9 KiB | 417.9 KiB |  |
| text/index | zig | 8.3 | 0.610 | 0.605 | 26640 | 22.9 | 49.9 KiB |  |  |
| text/index | applescript |  | 0.919 | 0.912 |  |  |  |  |  |
| text/index | gopher-lua |  | 0.123 | 0.123 |  |  |  | 29.3 KiB | 1055 |
| text/iterate | ts | 95.8 | 2.725 | 2.555 | 30318 | 89.9 | 93.0 KiB | 638.5 KiB |  |
| text/iterate | zig | 7.4 | 0.516 | 0.516 | 30318 | 17.0 | 93.0 KiB |  |  |
| text/iterate | applescript |  | 3.456 | 3.447 |  |  |  |  |  |
| text/iterate | gopher-lua |  | 0.188 | 0.186 |  |  |  | 187.3 KiB | 9847 |
| text/patterns | ts | 123.3 | 5.461 | 5.066 | 13818 | 395.2 | 225.9 KiB | 2.5 MiB |  |
| text/patterns | zig | 7.7 | 0.577 | 0.574 | 13818 | 41.8 | 225.9 KiB |  |  |
| text/patterns | applescript |  | 16.278 | 16.087 |  |  |  |  |  |
| text/patterns | gopher-lua |  | 0.281 | 0.279 |  |  |  | 390.8 KiB | 17736 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- core/fib@slice=10 on zig: 100.5 ns/Fuel, 5.8× the median
- collections/map-build on zig: 64.1 ns/Fuel, 3.7× the median
- host/pump on zig: 242.1 ns/Fuel, 13.9× the median
- messaging/suspend on zig: 59.0 ns/Fuel, 3.4× the median
- lifecycle/load-small on zig: 241.0 ns/Fuel, 13.9× the median
- text/patterns on ts: 395.2 ns/Fuel, 4.3× the median
- host/suspending on ts: 360.7 ns/Fuel, 3.9× the median
- host/conversion on ts: 359.7 ns/Fuel, 3.9× the median
- host/pump on ts: 976.6 ns/Fuel, 10.5× the median
- messaging/suspend on ts: 305.6 ns/Fuel, 3.3× the median
- lifecycle/load-small on ts: 1030.1 ns/Fuel, 11.1× the median
- lifecycle/rollback on ts: 486.6 ns/Fuel, 5.2× the median

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
