# Benchmark results, 2026-10-18

Commit `reactor-v0.5.0-77-gf67b03f2-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host zig cc -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 3, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | ts | 193.2 | 6.044 | 5.722 | 89459 | 67.6 | 195.6 KiB | 1.5 MiB |  |
| collections/iterate | zig | 14.5 | 0.389 | 0.387 | 89459 | 4.3 | 195.6 KiB |  |  |
| collections/iterate | applescript |  | 6.032 | 6.031 |  |  |  |  |  |
| collections/iterate | gopher-lua |  | 0.390 | 0.389 |  |  |  | 108.9 KiB | 6741 |
| collections/list-append | ts | 191.4 | 4.822 | 4.230 | 52056 | 92.6 | 78.3 KiB | 740.0 KiB |  |
| collections/list-append | zig | 10.6 | 0.372 | 0.370 | 52056 | 7.1 | 78.3 KiB |  |  |
| collections/list-append | applescript |  | 1.392 | 1.378 |  |  |  |  |  |
| collections/list-append | gopher-lua |  | 0.176 | 0.176 |  |  |  | 203.9 KiB | 4315 |
| collections/list-build | ts | 116.6 | 1.031 | 0.968 | 19091 | 54.0 | 2.9 MiB | 280.1 KiB |  |
| collections/list-build | zig | 7.5 | 0.0739 | 0.0738 | 19091 | 3.9 | 2.9 MiB |  |  |
| collections/list-build | applescript |  | 0.228 | 0.227 |  |  |  |  |  |
| collections/list-build | gopher-lua |  | 0.0374 | 0.0372 |  |  |  | 35.4 KiB | 1045 |
| collections/list-update | ts | 165.5 | 3.804 | 2.218 | 28553 | 133.2 | 23.8 KiB | 562.7 KiB |  |
| collections/list-update | zig | 10.5 | 0.187 | 0.182 | 28553 | 6.5 | 23.8 KiB |  |  |
| collections/list-update | applescript |  | 0.372 | 0.370 |  |  |  |  |  |
| collections/list-update | gopher-lua |  | 0.0256 | 0.0256 |  |  |  | 22.4 KiB | 106 |
| collections/map-build | ts | 131.1 | 1.088 | 1.025 | 14094 | 77.2 | 24.3 KiB | 198.4 KiB |  |
| collections/map-build | zig | 9.6 | 0.240 | 0.239 | 14094 | 17.0 | 24.3 KiB |  |  |
| collections/map-build | applescript |  | 5.693 | 5.688 |  |  |  |  |  |
| collections/map-build | gopher-lua |  | 0.0787 | 0.0785 |  |  |  | 90.5 KiB | 1291 |
| collections/map-update | ts | 169.0 | 0.814 | 0.740 | 8056 | 101.0 | 12.1 KiB | 139.2 KiB |  |
| collections/map-update | zig | 11.5 | 0.128 | 0.127 | 8056 | 15.9 | 12.1 KiB |  |  |
| collections/map-update | applescript |  | 3.426 | 3.399 |  |  |  |  |  |
| collections/map-update | gopher-lua |  | 0.0188 | 0.0188 |  |  |  | 10.2 KiB | 76 |
| core/calls | ts | 138.3 | 1.949 | 1.823 | 46018 | 42.4 | 31.3 KiB | 204.1 KiB |  |
| core/calls | zig | 8.1 | 0.338 | 0.336 | 46018 | 7.3 | 31.3 KiB |  |  |
| core/calls | applescript |  | 0.603 | 0.602 |  |  |  |  |  |
| core/calls | gopher-lua |  | 0.0706 | 0.0703 |  |  |  | 44.8 KiB | 180 |
| core/fib | ts | 140.3 | 2.210 | 1.786 | 46365 | 47.7 | 46.2 KiB | 158.3 KiB |  |
| core/fib | zig | 7.4 | 0.298 | 0.297 | 46365 | 6.4 | 46.2 KiB |  |  |
| core/fib | applescript |  | 0.490 | 0.484 |  |  |  |  |  |
| core/fib | gopher-lua |  | 0.0713 | 0.0711 |  |  |  | 63 B | 1 |
| core/fib@slice=10 | ts | 100.2 | 10.151 | 9.316 | 46365 | 218.9 | 46.2 KiB | 1.0 MiB |  |
| core/fib@slice=10 | zig | 7.4 | 1.311 | 1.303 | 46365 | 28.3 | 46.2 KiB |  |  |
| core/fib@slice=100 | ts | 84.3 | 2.810 | 2.637 | 46365 | 60.6 | 46.2 KiB | 42.9 KiB |  |
| core/fib@slice=100 | zig | 7.4 | 0.418 | 0.417 | 46365 | 9.0 | 46.2 KiB |  |  |
| core/fib@slice=1000 | ts | 81.9 | 2.043 | 1.946 | 46365 | 44.1 | 46.2 KiB | 38.2 KiB |  |
| core/fib@slice=1000 | zig | 7.4 | 0.313 | 0.312 | 46365 | 6.7 | 46.2 KiB |  |  |
| core/fib@slice=10000 | ts | 82.2 | 1.985 | 1.872 | 46365 | 42.8 | 46.2 KiB | 3.1 KiB |  |
| core/fib@slice=10000 | zig | 7.4 | 0.304 | 0.304 | 46365 | 6.6 | 46.2 KiB |  |  |
| core/lambdas | ts | 168.7 | 2.720 | 2.503 | 58027 | 46.9 | 62.6 KiB | 406.0 KiB |  |
| core/lambdas | zig | 9.3 | 0.414 | 0.414 | 58027 | 7.1 | 62.6 KiB |  |  |
| core/lambdas | applescript |  | 0.653 | 0.652 |  |  |  |  |  |
| core/lambdas | gopher-lua |  | 0.0854 | 0.0851 |  |  |  | 60.3 KiB | 244 |
| core/loop | ts | 103.4 | 2.549 | 2.341 | 48016 | 53.1 | 62.5 KiB | 255.1 KiB |  |
| core/loop | zig | 7.0 | 0.141 | 0.140 | 48016 | 2.9 | 62.5 KiB |  |  |
| core/loop | applescript |  | 0.197 | 0.182 |  |  |  |  |  |
| core/loop | gopher-lua |  | 0.0257 | 0.0257 |  |  |  | 44.8 KiB | 180 |
| host/conversion | ts | 172.3 | 9.018 | 8.578 | 25018 | 360.5 | 220.3 KiB | 160.7 KiB |  |
| host/immediate | ts | 112.0 | 1.988 | 1.893 | 13518 | 147.0 | 15.7 KiB | 248.8 KiB |  |
| host/properties | ts | 110.7 | 1.932 | 1.686 | 9018 | 214.2 | 15.7 KiB | 23.0 KiB |  |
| host/pump | ts | 20.5 | 0.00676 | 0.00615 | 7 | 965.6 | 0 B | 4.1 KiB |  |
| host/pump | zig | 2.4 | 0.000900 | 0.000892 | 7 | 128.5 | 0 B |  |  |
| host/suspending | ts | 119.5 | 5.022 | 4.767 | 13518 | 371.5 | 15.7 KiB | 99.0 KiB |  |
| lifecycle/load-large | ts | 14731.8 | 0.646 | 0.612 | 4609 | 140.2 | 16.3 KiB | 1002 B |  |
| lifecycle/load-large | zig | 796.1 | 0.0600 | 0.0597 | 4609 | 13.0 | 16.3 KiB |  |  |
| lifecycle/load-small | ts | 29.9 | 0.00656 | 0.00638 | 7 | 936.8 | 0 B | 1.5 KiB |  |
| lifecycle/load-small | zig | 3.4 | 0.000894 | 0.000892 | 7 | 127.7 | 0 B |  |  |
| lifecycle/restore | ts | 236.2 | 6.703 | 6.391 | 8015 | 836.2 | 7.8 KiB | 34.1 KiB |  |
| lifecycle/rollback | ts | 255.5 | 56.618 | 48.067 | 102023 | 555.0 | 39.9 KiB | 9.8 KiB |  |
| macro/game-tick | ts | 197.6 | 5.061 | 4.742 | 67042 | 75.5 | 78.4 KiB | 7.9 KiB |  |
| macro/game-tick | zig | 13.3 | 0.879 | 0.873 | 67042 | 13.1 | 78.4 KiB |  |  |
| macro/game-tick | applescript |  | 1.347 | 1.347 |  |  |  |  |  |
| macro/game-tick | gopher-lua |  | 0.127 | 0.127 |  |  |  | 28.7 KiB | 128 |
| macro/report | ts | 115.7 | 1.585 | 1.436 | 86555 | 18.3 | 1.2 MiB | 2.2 MiB |  |
| macro/report | zig | 8.0 | 0.461 | 0.449 | 86555 | 5.3 | 1.2 MiB |  |  |
| macro/report | applescript |  | 3.061 | 3.040 |  |  |  |  |  |
| macro/report | gopher-lua |  | 0.124 | 0.123 |  |  |  | 33.1 KiB | 1291 |
| macro/transform | ts | 157.7 | 1.854 | 1.773 | 20664 | 89.7 | 6.1 MiB | 305.6 KiB |  |
| macro/transform | zig | 11.3 | 0.159 | 0.159 | 20664 | 7.7 | 6.1 MiB |  |  |
| macro/transform | applescript |  | 0.338 | 0.336 |  |  |  |  |  |
| macro/transform | gopher-lua |  | 0.123 | 0.123 |  |  |  | 268.0 KiB | 4538 |
| messaging/joins | ts | 215.6 | 18.611 | 17.630 | 127218 | 146.3 | 239.1 KiB | 7.1 KiB |  |
| messaging/parents | ts | 141.5 | 14.202 | 13.302 | 67518 | 210.3 | 93.8 KiB | 181.9 KiB |  |
| messaging/sends | ts | 157.7 | 15.602 | 14.810 | 67518 | 231.1 | 93.8 KiB | 125.9 KiB |  |
| messaging/suspend | ts | 95.4 | 13.135 | 12.805 | 48018 | 273.5 | 31.3 KiB | 321 B |  |
| messaging/suspend | zig | 6.7 | 1.138 | 1.135 | 48018 | 23.7 | 31.3 KiB |  |  |
| numbers/add | ts | 122.7 | 1.517 | 1.387 | 26030 | 58.3 | 31.4 KiB | 216.9 KiB |  |
| numbers/add | zig | 6.9 | 0.126 | 0.126 | 26030 | 4.8 | 31.4 KiB |  |  |
| numbers/add | applescript |  | 0.230 | 0.229 |  |  |  |  |  |
| numbers/add | gopher-lua |  | 0.0265 | 0.0264 |  |  |  | 43.9 KiB | 177 |
| numbers/divide | ts | 90.3 | 1.259 | 1.171 | 18031 | 69.8 | 31.4 KiB | 315.4 KiB |  |
| numbers/divide | zig | 7.0 | 0.129 | 0.128 | 18031 | 7.1 | 31.4 KiB |  |  |
| numbers/divide | applescript |  | 0.191 | 0.191 |  |  |  |  |  |
| numbers/divide | gopher-lua |  | 0.0197 | 0.0197 |  |  |  | 28.3 KiB | 115 |
| numbers/multiply | ts | 94.3 | 1.085 | 0.985 | 18031 | 60.2 | 31.4 KiB | 216.3 KiB |  |
| numbers/multiply | zig | 7.1 | 0.0813 | 0.0811 | 18031 | 4.5 | 31.4 KiB |  |  |
| numbers/multiply | applescript |  | 0.173 | 0.173 |  |  |  |  |  |
| numbers/multiply | gopher-lua |  | 0.0182 | 0.0182 |  |  |  | 29.1 KiB | 118 |
| numbers/quantity | ts | 119.0 | 1.262 | 1.110 | 14579 | 86.6 | 39.1 KiB | 250.0 KiB |  |
| numbers/quantity | zig | 9.0 | 0.159 | 0.159 | 14579 | 10.9 | 39.1 KiB |  |  |
| numbers/quantity | applescript |  | 0.119 | 0.119 |  |  |  |  |  |
| numbers/quantity | gopher-lua |  | 0.0115 | 0.0115 |  |  |  | 16.5 KiB | 67 |
| text/build | ts | 79.6 | 0.734 | 0.685 | 28928 | 25.4 | 374.8 KiB | 247.0 KiB |  |
| text/build | zig | 6.1 | 0.0566 | 0.0561 | 28928 | 2.0 | 374.8 KiB |  |  |
| text/build | applescript |  | 0.364 | 0.362 |  |  |  |  |  |
| text/build | gopher-lua |  | 0.0651 | 0.0650 |  |  |  | 400.8 KiB | 1024 |
| text/graphemes | ts | 100.5 | 4.999 | 4.792 | 43518 | 114.9 | 144.1 KiB | 572.2 KiB |  |
| text/graphemes | zig | 7.9 | 0.672 | 0.670 | 43518 | 15.4 | 144.1 KiB |  |  |
| text/index | ts | 113.5 | 2.166 | 2.034 | 26640 | 81.3 | 49.9 KiB | 367.4 KiB |  |
| text/index | zig | 8.0 | 0.425 | 0.424 | 26640 | 16.0 | 49.9 KiB |  |  |
| text/index | applescript |  | 0.878 | 0.871 |  |  |  |  |  |
| text/index | gopher-lua |  | 0.112 | 0.112 |  |  |  | 29.3 KiB | 1055 |
| text/iterate | ts | 93.4 | 2.617 | 2.495 | 30318 | 86.3 | 93.0 KiB | 441.0 KiB |  |
| text/iterate | zig | 7.5 | 0.243 | 0.243 | 30318 | 8.0 | 93.0 KiB |  |  |
| text/iterate | applescript |  | 3.369 | 3.363 |  |  |  |  |  |
| text/iterate | gopher-lua |  | 0.164 | 0.164 |  |  |  | 187.3 KiB | 9847 |
| text/patterns | ts | 122.0 | 5.361 | 5.026 | 13818 | 387.9 | 225.9 KiB | 2.0 MiB |  |
| text/patterns | zig | 7.8 | 0.512 | 0.510 | 13818 | 37.1 | 225.9 KiB |  |  |
| text/patterns | applescript |  | 15.300 | 15.270 |  |  |  |  |  |
| text/patterns | gopher-lua |  | 0.248 | 0.248 |  |  |  | 390.8 KiB | 17736 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- core/fib@slice=10 on zig: 28.3 ns/Fuel, 3.8× the median
- text/patterns on zig: 37.1 ns/Fuel, 4.9× the median
- host/pump on zig: 128.5 ns/Fuel, 17.1× the median
- messaging/suspend on zig: 23.7 ns/Fuel, 3.2× the median
- lifecycle/load-small on zig: 127.7 ns/Fuel, 17.0× the median
- text/patterns on ts: 387.9 ns/Fuel, 4.4× the median
- host/suspending on ts: 371.5 ns/Fuel, 4.2× the median
- host/conversion on ts: 360.5 ns/Fuel, 4.1× the median
- host/pump on ts: 965.6 ns/Fuel, 11.0× the median
- messaging/suspend on ts: 273.5 ns/Fuel, 3.1× the median
- lifecycle/load-small on ts: 936.8 ns/Fuel, 10.6× the median
- lifecycle/rollback on ts: 555.0 ns/Fuel, 6.3× the median

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
