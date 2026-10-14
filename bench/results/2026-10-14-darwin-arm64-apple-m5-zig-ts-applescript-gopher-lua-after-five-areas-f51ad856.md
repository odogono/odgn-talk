# Benchmark results, 2026-10-14

Commit `f51ad856` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), gopher-lua v1.1.2.
Settings: count 3, runners zig,ts,applescript,gopher-lua, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | ts | 241.2 | 6.892 | 6.566 | 89459 | 77.0 | 195.6 KiB | 1.4 MiB |  |
| collections/iterate | zig | 13.2 | 1.604 | 1.602 | 89459 | 17.9 | 195.6 KiB |  |  |
| collections/iterate | applescript |  | 5.939 | 5.925 |  |  |  |  |  |
| collections/iterate | gopher-lua |  | 0.393 | 0.392 |  |  |  | 108.9 KiB | 6741 |
| collections/list-append | ts | 187.5 | 6.832 | 5.493 | 52056 | 131.2 | 78.3 KiB | 911.6 KiB |  |
| collections/list-append | zig | 10.0 | 1.019 | 1.016 | 52056 | 19.6 | 78.3 KiB |  |  |
| collections/list-append | applescript |  | 1.403 | 1.400 |  |  |  |  |  |
| collections/list-append | gopher-lua |  | 0.177 | 0.176 |  |  |  | 203.9 KiB | 4315 |
| collections/list-build | ts | 115.4 | 1.337 | 1.220 | 19091 | 70.1 | 2.9 MiB | 277.9 KiB |  |
| collections/list-build | zig | 7.0 | 0.229 | 0.226 | 19091 | 12.0 | 2.9 MiB |  |  |
| collections/list-build | applescript |  | 0.228 | 0.227 |  |  |  |  |  |
| collections/list-build | gopher-lua |  | 0.0373 | 0.0372 |  |  |  | 35.4 KiB | 1045 |
| collections/list-update | ts | 194.0 | 4.519 | 2.852 | 28553 | 158.3 | 23.8 KiB | 541.9 KiB |  |
| collections/list-update | zig | 10.1 | 0.591 | 0.590 | 28553 | 20.7 | 23.8 KiB |  |  |
| collections/list-update | applescript |  | 0.372 | 0.372 |  |  |  |  |  |
| collections/list-update | gopher-lua |  | 0.0257 | 0.0256 |  |  |  | 22.4 KiB | 106 |
| collections/map-build | ts | 150.5 | 1.317 | 1.151 | 14094 | 93.4 | 24.3 KiB | 306.6 KiB |  |
| collections/map-build | zig | 8.9 | 0.924 | 0.918 | 14094 | 65.6 | 24.3 KiB |  |  |
| collections/map-build | applescript |  | 5.726 | 5.715 |  |  |  |  |  |
| collections/map-build | gopher-lua |  | 0.0787 | 0.0787 |  |  |  | 90.5 KiB | 1291 |
| collections/map-update | ts | 180.1 | 0.963 | 0.916 | 8056 | 119.5 | 12.1 KiB | 123.3 KiB |  |
| collections/map-update | zig | 11.1 | 0.220 | 0.220 | 8056 | 27.3 | 12.1 KiB |  |  |
| collections/map-update | applescript |  | 3.437 | 3.429 |  |  |  |  |  |
| collections/map-update | gopher-lua |  | 0.0186 | 0.0186 |  |  |  | 10.2 KiB | 76 |
| core/calls | ts | 129.5 | 2.737 | 2.517 | 46018 | 59.5 | 31.3 KiB | 131.8 KiB |  |
| core/calls | zig | 7.6 | 0.697 | 0.696 | 46018 | 15.1 | 31.3 KiB |  |  |
| core/calls | applescript |  | 0.595 | 0.595 |  |  |  |  |  |
| core/calls | gopher-lua |  | 0.0704 | 0.0703 |  |  |  | 44.8 KiB | 180 |
| core/fib | ts | 122.5 | 2.349 | 1.927 | 46365 | 50.7 | 46.2 KiB | 260.3 KiB |  |
| core/fib | zig | 7.2 | 0.735 | 0.735 | 46365 | 15.9 | 46.2 KiB |  |  |
| core/fib | applescript |  | 0.469 | 0.469 |  |  |  |  |  |
| core/fib | gopher-lua |  | 0.0711 | 0.0710 |  |  |  | 63 B | 1 |
| core/fib@slice=10 | ts | 83.7 | 10.617 | 9.393 | 46365 | 229.0 | 46.2 KiB | 734.4 KiB |  |
| core/fib@slice=10 | zig | 7.1 | 4.761 | 4.742 | 46365 | 102.7 | 46.2 KiB |  |  |
| core/fib@slice=100 | ts | 78.6 | 2.976 | 2.748 | 46365 | 64.2 | 46.2 KiB | 7.0 KiB |  |
| core/fib@slice=100 | zig | 7.1 | 1.168 | 1.155 | 46365 | 25.2 | 46.2 KiB |  |  |
| core/fib@slice=1000 | ts | 74.7 | 2.210 | 2.060 | 46365 | 47.7 | 46.2 KiB | 1.8 KiB |  |
| core/fib@slice=1000 | zig | 7.1 | 0.794 | 0.788 | 46365 | 17.1 | 46.2 KiB |  |  |
| core/fib@slice=10000 | ts | 76.8 | 2.133 | 1.982 | 46365 | 46.0 | 46.2 KiB | 0 B |  |
| core/fib@slice=10000 | zig | 7.0 | 0.747 | 0.743 | 46365 | 16.1 | 46.2 KiB |  |  |
| core/lambdas | ts | 141.3 | 3.903 | 3.475 | 58027 | 67.3 | 62.6 KiB | 540.3 KiB |  |
| core/lambdas | zig | 8.7 | 0.924 | 0.922 | 58027 | 15.9 | 62.6 KiB |  |  |
| core/lambdas | applescript |  | 0.644 | 0.642 |  |  |  |  |  |
| core/lambdas | gopher-lua |  | 0.0854 | 0.0853 |  |  |  | 60.3 KiB | 244 |
| core/loop | ts | 96.7 | 2.858 | 2.668 | 48016 | 59.5 | 62.5 KiB | 267.0 KiB |  |
| core/loop | zig | 6.6 | 1.025 | 1.022 | 48016 | 21.4 | 62.5 KiB |  |  |
| core/loop | applescript |  | 0.181 | 0.181 |  |  |  |  |  |
| core/loop | gopher-lua |  | 0.0259 | 0.0259 |  |  |  | 44.8 KiB | 180 |
| host/conversion | ts | 184.3 | 9.321 | 8.999 | 25018 | 372.6 | 220.3 KiB | 1.1 MiB |  |
| host/immediate | ts | 115.9 | 2.188 | 2.068 | 13518 | 161.8 | 15.7 KiB | 157.7 KiB |  |
| host/properties | ts | 109.8 | 2.008 | 1.585 | 9018 | 222.7 | 15.7 KiB | 105.5 KiB |  |
| host/pump | ts | 20.1 | 0.00689 | 0.00649 | 7 | 984.9 | 0 B | 2.5 KiB |  |
| host/pump | zig | 2.4 | 0.00213 | 0.00207 | 7 | 303.9 | 0 B |  |  |
| host/suspending | ts | 120.6 | 4.828 | 4.138 | 13518 | 357.2 | 15.7 KiB | 738.3 KiB |  |
| lifecycle/load-large | ts | 14229.8 | 0.668 | 0.639 | 4609 | 144.9 | 16.3 KiB | 278 B |  |
| lifecycle/load-large | zig | 739.5 | 0.153 | 0.152 | 4609 | 33.2 | 16.3 KiB |  |  |
| lifecycle/load-small | ts | 30.3 | 0.00679 | 0.00645 | 7 | 969.7 | 0 B | 3.1 KiB |  |
| lifecycle/load-small | zig | 3.0 | 0.00168 | 0.00168 | 7 | 240.5 | 0 B |  |  |
| lifecycle/restore | ts | 234.5 | 6.794 | 6.454 | 8015 | 847.6 | 7.8 KiB | 40.2 KiB |  |
| lifecycle/rollback | ts | 246.7 | 62.699 | 60.063 | 102023 | 614.6 | 39.9 KiB | 68.4 KiB |  |
| macro/game-tick | ts | 199.1 | 5.703 | 5.599 | 67042 | 85.1 | 78.4 KiB | 5.0 KiB |  |
| macro/game-tick | zig | 12.7 | 1.381 | 1.376 | 67042 | 20.6 | 78.4 KiB |  |  |
| macro/game-tick | applescript |  | 1.350 | 1.343 |  |  |  |  |  |
| macro/game-tick | gopher-lua |  | 0.126 | 0.125 |  |  |  | 28.7 KiB | 128 |
| macro/report | ts | 118.5 | 2.123 | 2.047 | 86555 | 24.5 | 1.2 MiB | 2.4 MiB |  |
| macro/report | zig | 7.6 | 1.169 | 1.166 | 86555 | 13.5 | 1.2 MiB |  |  |
| macro/report | applescript |  | 3.121 | 3.088 |  |  |  |  |  |
| macro/report | gopher-lua |  | 0.126 | 0.126 |  |  |  | 33.1 KiB | 1291 |
| macro/transform | ts | 163.4 | 3.055 | 2.968 | 20664 | 147.9 | 6.1 MiB | 2.6 KiB |  |
| macro/transform | zig | 10.7 | 0.304 | 0.304 | 20664 | 14.7 | 6.1 MiB |  |  |
| macro/transform | applescript |  | 0.332 | 0.332 |  |  |  |  |  |
| macro/transform | gopher-lua |  | 0.124 | 0.123 |  |  |  | 268.0 KiB | 4538 |
| messaging/joins | ts | 228.0 | 20.820 | 18.873 | 127218 | 163.7 | 239.1 KiB | 11.6 KiB |  |
| messaging/parents | ts | 148.3 | 15.146 | 14.566 | 67518 | 224.3 | 93.8 KiB | 111.2 KiB |  |
| messaging/sends | ts | 173.5 | 16.215 | 15.613 | 67518 | 240.2 | 93.8 KiB | 940.6 KiB |  |
| messaging/suspend | ts | 103.7 | 17.536 | 16.683 | 48018 | 365.2 | 31.3 KiB | 14.3 KiB |  |
| messaging/suspend | zig | 6.4 | 3.229 | 2.955 | 48018 | 67.3 | 31.3 KiB |  |  |
| numbers/add | ts | 96.4 | 2.398 | 2.235 | 26030 | 92.1 | 31.4 KiB | 254.5 KiB |  |
| numbers/add | zig | 6.7 | 0.506 | 0.505 | 26030 | 19.4 | 31.4 KiB |  |  |
| numbers/add | applescript |  | 0.225 | 0.224 |  |  |  |  |  |
| numbers/add | gopher-lua |  | 0.0265 | 0.0264 |  |  |  | 43.9 KiB | 177 |
| numbers/divide | ts | 87.3 | 2.169 | 2.044 | 18031 | 120.3 | 31.4 KiB | 408.8 KiB |  |
| numbers/divide | zig | 6.7 | 0.360 | 0.359 | 18031 | 19.9 | 31.4 KiB |  |  |
| numbers/divide | applescript |  | 0.190 | 0.189 |  |  |  |  |  |
| numbers/divide | gopher-lua |  | 0.0198 | 0.0197 |  |  |  | 28.3 KiB | 115 |
| numbers/multiply | ts | 99.2 | 1.507 | 1.399 | 18031 | 83.6 | 31.4 KiB | 216.9 KiB |  |
| numbers/multiply | zig | 6.8 | 0.329 | 0.328 | 18031 | 18.2 | 31.4 KiB |  |  |
| numbers/multiply | applescript |  | 0.173 | 0.172 |  |  |  |  |  |
| numbers/multiply | gopher-lua |  | 0.0182 | 0.0182 |  |  |  | 29.1 KiB | 118 |
| numbers/quantity | ts | 152.8 | 4.106 | 3.836 | 14579 | 281.7 | 39.1 KiB | 498.3 KiB |  |
| numbers/quantity | zig | 8.3 | 0.394 | 0.393 | 14579 | 27.0 | 39.1 KiB |  |  |
| numbers/quantity | applescript |  | 0.117 | 0.117 |  |  |  |  |  |
| numbers/quantity | gopher-lua |  | 0.0115 | 0.0115 |  |  |  | 16.5 KiB | 67 |
| text/build | ts | 95.8 | 1.089 | 1.030 | 28928 | 37.6 | 374.8 KiB | 230.9 KiB |  |
| text/build | zig | 5.8 | 0.416 | 0.416 | 28928 | 14.4 | 374.8 KiB |  |  |
| text/build | applescript |  | 0.455 | 0.386 |  |  |  |  |  |
| text/build | gopher-lua |  | 0.0650 | 0.0647 |  |  |  | 400.8 KiB | 1024 |
| text/graphemes | ts | 107.8 | 5.967 | 5.502 | 43518 | 137.1 | 144.1 KiB | 714.4 KiB |  |
| text/graphemes | zig | 7.5 | 1.120 | 1.119 | 43518 | 25.7 | 144.1 KiB |  |  |
| text/index | ts | 130.5 | 7.088 | 6.213 | 26640 | 266.1 | 49.9 KiB | 940.3 KiB |  |
| text/index | zig | 8.0 | 0.683 | 0.679 | 26640 | 25.6 | 49.9 KiB |  |  |
| text/index | applescript |  | 0.872 | 0.870 |  |  |  |  |  |
| text/index | gopher-lua |  | 0.112 | 0.112 |  |  |  | 29.3 KiB | 1055 |
| text/iterate | ts | 110.8 | 3.678 | 3.488 | 30318 | 121.3 | 93.0 KiB | 912.7 KiB |  |
| text/iterate | zig | 7.1 | 0.581 | 0.580 | 30318 | 19.2 | 93.0 KiB |  |  |
| text/iterate | applescript |  | 3.293 | 3.277 |  |  |  |  |  |
| text/iterate | gopher-lua |  | 0.165 | 0.165 |  |  |  | 187.3 KiB | 9847 |
| text/patterns | ts | 130.1 | 5.838 | 5.512 | 13818 | 422.5 | 225.9 KiB | 1.7 MiB |  |
| text/patterns | zig | 7.5 | 0.593 | 0.588 | 13818 | 42.9 | 225.9 KiB |  |  |
| text/patterns | applescript |  | 15.290 | 15.267 |  |  |  |  |  |
| text/patterns | gopher-lua |  | 0.248 | 0.248 |  |  |  | 390.8 KiB | 17736 |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- core/fib@slice=10 on zig: 102.7 ns/Fuel, 5.1× the median
- collections/map-build on zig: 65.6 ns/Fuel, 3.2× the median
- host/pump on zig: 303.9 ns/Fuel, 15.0× the median
- messaging/suspend on zig: 67.3 ns/Fuel, 3.3× the median
- lifecycle/load-small on zig: 240.5 ns/Fuel, 11.9× the median
- text/patterns on ts: 422.5 ns/Fuel, 3.1× the median
- host/pump on ts: 984.9 ns/Fuel, 7.3× the median
- lifecycle/load-small on ts: 969.7 ns/Fuel, 7.2× the median
- lifecycle/rollback on ts: 614.6 ns/Fuel, 4.6× the median

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
