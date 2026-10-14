# Benchmark results, 2026-10-14

Commit `04c7ac73-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.3, zig 0.17.0, zig build native safe; C Host -O2, cost model 0, go go1.27.2, language 1.0-rc.3, applescript 2.8 (macOS 27.0.1), cpython 3.14.8, gopher-lua v1.1.2, quickjs-emscripten 0.32.0, starlark-go v0.0.0-20261005163335-bcb1a1a55bf9, wasmoon 1.16.0.
Settings: count 10, runners go,ts,zig,peers, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | go | 41.5 | 4.352 | 4.327 | 89459 | 48.7 | 195.6 KiB | 1.6 MiB | 21796 |
| collections/iterate | ts | 241.8 | 6.628 | 6.295 | 89459 | 74.1 | 195.6 KiB | 1.5 MiB |  |
| collections/iterate | zig | 13.3 | 5.450 | 5.440 | 89459 | 60.9 | 195.6 KiB |  |  |
| collections/iterate | applescript |  | 5.960 | 5.891 |  |  |  |  |  |
| collections/iterate | cpython |  | 0.0550 | 0.0546 |  |  |  | 2.5 KiB |  |
| collections/iterate | go-native |  | 0.0185 | 0.0182 |  |  |  | 1.8 KiB | 4 |
| collections/iterate | gopher-lua |  | 0.428 | 0.425 |  |  |  | 108.9 KiB | 6741 |
| collections/iterate | quickjs |  | 0.149 | 0.139 |  |  |  |  |  |
| collections/iterate | starlark-go |  | 0.196 | 0.192 |  |  |  | 270.5 KiB | 783 |
| collections/iterate | ts-native |  | 0.00842 | 0.00820 |  |  |  | 8 B |  |
| collections/iterate | wasmoon |  | 0.117 | 0.111 |  |  |  |  |  |
| collections/list-append | go | 29.0 | 2.629 | 2.624 | 52056 | 50.5 | 78.3 KiB | 1.1 MiB | 16513 |
| collections/list-append | ts | 187.5 | 6.619 | 5.281 | 52056 | 127.1 | 78.3 KiB | 844.3 KiB |  |
| collections/list-append | zig | 9.8 | 2.457 | 2.448 | 52056 | 47.2 | 78.3 KiB |  |  |
| collections/list-append | applescript |  | 1.402 | 1.394 |  |  |  |  |  |
| collections/list-append | cpython |  | 0.0383 | 0.0373 |  |  |  | 67.2 KiB |  |
| collections/list-append | go-native |  | 0.00199 | 0.00197 |  |  |  | 16.0 KiB | 2 |
| collections/list-append | gopher-lua |  | 0.194 | 0.191 |  |  |  | 203.9 KiB | 4315 |
| collections/list-append | quickjs |  | 0.103 | 0.0943 |  |  |  |  |  |
| collections/list-append | starlark-go |  | 0.180 | 0.178 |  |  |  | 223.8 KiB | 4027 |
| collections/list-append | ts-native |  | 0.00563 | 0.00428 |  |  |  | 3 B |  |
| collections/list-append | wasmoon |  | 0.0453 | 0.0436 |  |  |  |  |  |
| collections/list-build | go | 21.3 | 0.606 | 0.605 | 19091 | 31.7 | 2.9 MiB | 250.0 KiB | 3593 |
| collections/list-build | ts | 115.0 | 1.310 | 1.200 | 19091 | 68.6 | 2.9 MiB | 256.6 KiB |  |
| collections/list-build | zig | 7.0 | 1.133 | 1.124 | 19091 | 59.3 | 2.9 MiB |  |  |
| collections/list-build | applescript |  | 0.226 | 0.225 |  |  |  |  |  |
| collections/list-build | cpython |  | 0.00786 | 0.00760 |  |  |  | 8.6 KiB |  |
| collections/list-build | go-native |  | 0.000596 | 0.000592 |  |  |  | 4.0 KiB | 2 |
| collections/list-build | gopher-lua |  | 0.0408 | 0.0406 |  |  |  | 35.4 KiB | 1045 |
| collections/list-build | quickjs |  | 0.0270 | 0.0245 |  |  |  |  |  |
| collections/list-build | starlark-go |  | 0.0192 | 0.0191 |  |  |  | 18.7 KiB | 18 |
| collections/list-build | ts-native |  | 0.000983 | 0.000864 |  |  |  | 0 B |  |
| collections/list-build | wasmoon |  | 0.0109 | 0.00983 |  |  |  |  |  |
| collections/list-update | go | 38.3 | 2.027 | 2.012 | 28553 | 71.0 | 23.8 KiB | 1.8 MiB | 52552 |
| collections/list-update | ts | 193.5 | 4.449 | 2.827 | 28553 | 155.8 | 23.8 KiB | 552.4 KiB |  |
| collections/list-update | zig | 9.9 | 0.899 | 0.897 | 28553 | 31.5 | 23.8 KiB |  |  |
| collections/list-update | applescript |  | 0.369 | 0.368 |  |  |  |  |  |
| collections/list-update | cpython |  | 0.00922 | 0.00913 |  |  |  | 184 B |  |
| collections/list-update | go-native |  | 0.000428 | 0.000392 |  |  |  | 72 B | 2 |
| collections/list-update | gopher-lua |  | 0.0288 | 0.0285 |  |  |  | 22.4 KiB | 106 |
| collections/list-update | quickjs |  | 0.0268 | 0.0254 |  |  |  |  |  |
| collections/list-update | starlark-go |  | 0.0338 | 0.0331 |  |  |  | 704 B | 13 |
| collections/list-update | ts-native |  | 0.00119 | 0.000812 |  |  |  | 0 B |  |
| collections/list-update | wasmoon |  | 0.00562 | 0.00558 |  |  |  |  |  |
| collections/map-build | go | 26.2 | 0.677 | 0.670 | 14094 | 48.0 | 24.3 KiB | 656.2 KiB | 9498 |
| collections/map-build | ts | 148.2 | 1.314 | 1.148 | 14094 | 93.2 | 24.3 KiB | 314.1 KiB |  |
| collections/map-build | zig | 9.0 | 5.738 | 5.701 | 14094 | 407.2 | 24.3 KiB |  |  |
| collections/map-build | applescript |  | 5.748 | 5.714 |  |  |  |  |  |
| collections/map-build | cpython |  | 0.0145 | 0.0145 |  |  |  | 19.3 KiB |  |
| collections/map-build | go-native |  | 0.00655 | 0.00636 |  |  |  | 13.9 KiB | 205 |
| collections/map-build | gopher-lua |  | 0.0897 | 0.0850 |  |  |  | 90.5 KiB | 1291 |
| collections/map-build | quickjs |  | 0.0354 | 0.0330 |  |  |  |  |  |
| collections/map-build | starlark-go |  | 0.0415 | 0.0406 |  |  |  | 99.4 KiB | 827 |
| collections/map-build | ts-native |  | 0.00609 | 0.00436 |  |  |  | 49 B |  |
| collections/map-build | wasmoon |  | 0.0418 | 0.0402 |  |  |  |  |  |
| collections/map-update | go | 40.5 | 0.453 | 0.450 | 8056 | 56.2 | 12.1 KiB | 301.9 KiB | 4588 |
| collections/map-update | ts | 177.6 | 0.941 | 0.893 | 8056 | 116.9 | 12.1 KiB | 117.6 KiB |  |
| collections/map-update | zig | 10.8 | 0.358 | 0.357 | 8056 | 44.4 | 12.1 KiB |  |  |
| collections/map-update | applescript |  | 3.453 | 3.432 |  |  |  |  |  |
| collections/map-update | cpython |  | 0.00422 | 0.00412 |  |  |  | 480 B |  |
| collections/map-update | go-native |  | 0.00314 | 0.00309 |  |  |  | 520 B | 5 |
| collections/map-update | gopher-lua |  | 0.0206 | 0.0204 |  |  |  | 10.2 KiB | 76 |
| collections/map-update | quickjs |  | 0.0271 | 0.0256 |  |  |  |  |  |
| collections/map-update | starlark-go |  | 0.0144 | 0.0143 |  |  |  | 1.7 KiB | 11 |
| collections/map-update | ts-native |  | 0.00180 | 0.00163 |  |  |  | 0 B |  |
| collections/map-update | wasmoon |  | 0.00342 | 0.00308 |  |  |  |  |  |
| core/calls | go | 23.0 | 1.812 | 1.806 | 46018 | 39.4 | 31.3 KiB | 1.0 MiB | 16009 |
| core/calls | ts | 130.5 | 2.713 | 2.495 | 46018 | 59.0 | 31.3 KiB | 216.5 KiB |  |
| core/calls | zig | 7.5 | 1.977 | 1.970 | 46018 | 43.0 | 31.3 KiB |  |  |
| core/calls | applescript |  | 0.598 | 0.597 |  |  |  |  |  |
| core/calls | cpython |  | 0.0329 | 0.0319 |  |  |  | 0 B |  |
| core/calls | go-native |  | 0.000488 | 0.000487 |  |  |  | 8 B | 1 |
| core/calls | gopher-lua |  | 0.0784 | 0.0778 |  |  |  | 44.8 KiB | 180 |
| core/calls | quickjs |  | 0.0535 | 0.0492 |  |  |  |  |  |
| core/calls | starlark-go |  | 0.125 | 0.124 |  |  |  | 125.3 KiB | 2006 |
| core/calls | ts-native |  | 0.000616 | 0.000594 |  |  |  | 0 B |  |
| core/calls | wasmoon |  | 0.0246 | 0.0241 |  |  |  |  |  |
| core/fib | go | 22.8 | 1.668 | 1.594 | 46365 | 36.0 | 46.2 KiB | 635.8 KiB | 9034 |
| core/fib | ts | 131.7 | 2.513 | 2.062 | 46365 | 54.2 | 46.2 KiB | 156.8 KiB |  |
| core/fib | zig | 7.0 | 2.146 | 2.124 | 46365 | 46.3 | 46.2 KiB |  |  |
| core/fib | applescript |  | 0.478 | 0.469 |  |  |  |  |  |
| core/fib | cpython |  | 0.0251 | 0.0248 |  |  |  | 0 B |  |
| core/fib | go-native |  | 0.00130 | 0.00129 |  |  |  | 8 B | 1 |
| core/fib | gopher-lua |  | 0.0783 | 0.0777 |  |  |  | 63 B | 1 |
| core/fib | quickjs |  | 0.0452 | 0.0404 |  |  |  |  |  |
| core/fib | starlark-go |  | 0.155 | 0.153 |  |  |  | 154.2 KiB | 1975 |
| core/fib | ts-native |  | 0.00236 | 0.00213 |  |  |  | 0 B |  |
| core/fib | wasmoon |  | 0.0276 | 0.0273 |  |  |  |  |  |
| core/fib@slice=10 | go | 22.7 | 5.220 | 5.194 | 46365 | 112.6 | 46.2 KiB | 4.5 MiB | 131109 |
| core/fib@slice=10 | ts | 96.8 | 9.977 | 8.757 | 46365 | 215.2 | 46.2 KiB | 761.6 KiB |  |
| core/fib@slice=10 | zig | 7.0 | 6.941 | 6.023 | 46365 | 149.7 | 46.2 KiB |  |  |
| core/fib@slice=100 | go | 23.0 | 2.147 | 2.089 | 46365 | 46.3 | 46.2 KiB | 1.5 MiB | 25178 |
| core/fib@slice=100 | ts | 79.6 | 2.881 | 2.680 | 46365 | 62.1 | 46.2 KiB | 41.9 KiB |  |
| core/fib@slice=100 | zig | 7.1 | 2.556 | 2.526 | 46365 | 55.1 | 46.2 KiB |  |  |
| core/fib@slice=1000 | go | 23.3 | 1.679 | 1.647 | 46365 | 36.2 | 46.2 KiB | 811.0 KiB | 11022 |
| core/fib@slice=1000 | ts | 78.3 | 2.185 | 2.046 | 46365 | 47.1 | 46.2 KiB | 14.6 KiB |  |
| core/fib@slice=1000 | zig | 7.2 | 2.202 | 2.179 | 46365 | 47.5 | 46.2 KiB |  |  |
| core/fib@slice=10000 | go | 23.1 | 1.676 | 1.588 | 46365 | 36.1 | 46.2 KiB | 660.9 KiB | 9221 |
| core/fib@slice=10000 | ts | 78.3 | 2.069 | 1.977 | 46365 | 44.6 | 46.2 KiB | 9.1 KiB |  |
| core/fib@slice=10000 | zig | 7.0 | 2.140 | 2.133 | 46365 | 46.2 | 46.2 KiB |  |  |
| core/lambdas | go | 26.1 | 2.400 | 2.394 | 58027 | 41.4 | 62.6 KiB | 1.4 MiB | 21989 |
| core/lambdas | ts | 160.0 | 3.854 | 3.348 | 58027 | 66.4 | 62.6 KiB | 474.5 KiB |  |
| core/lambdas | zig | 8.8 | 3.330 | 3.325 | 58027 | 57.4 | 62.6 KiB |  |  |
| core/lambdas | applescript |  | 0.650 | 0.646 |  |  |  |  |  |
| core/lambdas | cpython |  | 0.0435 | 0.0425 |  |  |  | 208 B |  |
| core/lambdas | go-native |  | 0.000512 | 0.000500 |  |  |  | 8 B | 1 |
| core/lambdas | gopher-lua |  | 0.0948 | 0.0936 |  |  |  | 60.3 KiB | 244 |
| core/lambdas | quickjs |  | 0.0585 | 0.0527 |  |  |  |  |  |
| core/lambdas | starlark-go |  | 0.151 | 0.150 |  |  |  | 156.6 KiB | 2010 |
| core/lambdas | ts-native |  | 0.00106 | 0.00101 |  |  |  | 0 B |  |
| core/lambdas | wasmoon |  | 0.0303 | 0.0272 |  |  |  |  |  |
| core/loop | go | 20.3 | 2.820 | 2.810 | 48016 | 58.7 | 62.5 KiB | 218.6 KiB | 7973 |
| core/loop | ts | 101.6 | 3.056 | 2.726 | 48016 | 63.7 | 62.5 KiB | 341.0 KiB |  |
| core/loop | zig | 6.6 | 3.408 | 3.394 | 48016 | 71.0 | 62.5 KiB |  |  |
| core/loop | applescript |  | 0.183 | 0.179 |  |  |  |  |  |
| core/loop | cpython |  | 0.0195 | 0.0193 |  |  |  | 0 B |  |
| core/loop | go-native |  | 0.000489 | 0.000487 |  |  |  | 8 B | 1 |
| core/loop | gopher-lua |  | 0.0288 | 0.0286 |  |  |  | 44.8 KiB | 180 |
| core/loop | quickjs |  | 0.0214 | 0.0198 |  |  |  |  |  |
| core/loop | starlark-go |  | 0.0426 | 0.0425 |  |  |  | 256 B | 6 |
| core/loop | ts-native |  | 0.000601 | 0.000576 |  |  |  | 0 B |  |
| core/loop | wasmoon |  | 0.00744 | 0.00733 |  |  |  |  |  |
| host/conversion | go | 33.7 | 2.574 | 2.501 | 25018 | 102.9 | 220.3 KiB | 3.1 MiB | 66651 |
| host/conversion | ts | 187.8 | 9.573 | 9.070 | 25018 | 382.6 | 220.3 KiB | 485.6 KiB |  |
| host/immediate | go | 29.6 | 0.775 | 0.761 | 13518 | 57.3 | 15.7 KiB | 950.9 KiB | 12249 |
| host/immediate | ts | 115.3 | 2.126 | 2.011 | 13518 | 157.2 | 15.7 KiB | 268.0 KiB |  |
| host/properties | go | 25.6 | 0.552 | 0.549 | 9018 | 61.2 | 15.7 KiB | 467.8 KiB | 6918 |
| host/properties | ts | 114.0 | 1.996 | 1.518 | 9018 | 221.4 | 15.7 KiB | 130.7 KiB |  |
| host/pump | go | 8.2 | 0.00310 | 0.00297 | 7 | 442.9 | 0 B | 6.3 KiB | 68 |
| host/pump | ts | 19.8 | 0.00690 | 0.00655 | 7 | 986.3 | 0 B | 2.8 KiB |  |
| host/pump | zig | 2.7 | 0.00211 | 0.00157 | 7 | 302.1 | 0 B |  |  |
| host/suspending | go | 29.8 | 2.124 | 2.096 | 13518 | 157.2 | 15.7 KiB | 3.8 MiB | 52988 |
| host/suspending | ts | 119.5 | 4.797 | 4.104 | 13518 | 354.8 | 15.7 KiB | 428.2 KiB |  |
| lifecycle/load-large | go | 1900.2 | 0.243 | 0.241 | 4609 | 52.8 | 16.3 KiB | 134.4 KiB | 2087 |
| lifecycle/load-large | ts | 17761.8 | 0.773 | 0.709 | 4609 | 167.6 | 16.3 KiB | 1.6 MiB |  |
| lifecycle/load-large | zig | 765.1 | 0.292 | 0.290 | 4609 | 63.3 | 16.3 KiB |  |  |
| lifecycle/load-small | go | 12.6 | 0.00307 | 0.00302 | 7 | 439.1 | 0 B | 6.3 KiB | 71 |
| lifecycle/load-small | ts | 30.3 | 0.00723 | 0.00703 | 7 | 1032.2 | 0 B | 1.7 KiB |  |
| lifecycle/load-small | zig | 3.4 | 0.00170 | 0.00167 | 7 | 242.3 | 0 B |  |  |
| lifecycle/restore | go | 42.9 | 17.427 | 16.944 | 8015 | 2174.3 | 7.8 KiB | 15.4 MiB | 182614 |
| lifecycle/restore | ts | 284.8 | 12.580 | 9.275 | 8015 | 1569.6 | 7.8 KiB | 1.6 MiB |  |
| lifecycle/rollback | go | 51.3 | 14.992 | 14.118 | 102023 | 146.9 | 39.9 KiB | 37.1 MiB | 270599 |
| lifecycle/rollback | ts | 307.5 | 104.117 | 89.579 | 102023 | 1020.5 | 39.9 KiB | 2.4 MiB |  |
| macro/game-tick | go | 47.8 | 2.714 | 2.697 | 67042 | 40.5 | 78.4 KiB | 1.2 MiB | 28903 |
| macro/game-tick | ts | 200.4 | 5.794 | 5.576 | 67042 | 86.4 | 78.4 KiB | 5.8 KiB |  |
| macro/game-tick | zig | 12.6 | 3.166 | 3.075 | 67042 | 47.2 | 78.4 KiB |  |  |
| macro/game-tick | applescript |  | 1.354 | 1.349 |  |  |  |  |  |
| macro/game-tick | cpython |  | 0.0537 | 0.0535 |  |  |  | 0 B |  |
| macro/game-tick | go-native |  | 0.000257 | 0.000253 |  |  |  | 8 B | 1 |
| macro/game-tick | gopher-lua |  | 0.139 | 0.130 |  |  |  | 28.7 KiB | 128 |
| macro/game-tick | quickjs |  | 0.0611 | 0.0593 |  |  |  |  |  |
| macro/game-tick | starlark-go |  | 0.162 | 0.160 |  |  |  | 94.5 KiB | 1007 |
| macro/game-tick | ts-native |  | 0.000343 | 0.000333 |  |  |  | 0 B |  |
| macro/game-tick | wasmoon |  | 0.0243 | 0.0220 |  |  |  |  |  |
| macro/report | go | 30.4 | 1.152 | 1.135 | 86555 | 13.3 | 1.2 MiB | 1.5 MiB | 4571 |
| macro/report | ts | 117.8 | 2.074 | 1.972 | 86555 | 24.0 | 1.2 MiB | 2.3 MiB |  |
| macro/report | zig | 7.8 | 1.393 | 1.361 | 86555 | 16.1 | 1.2 MiB |  |  |
| macro/report | applescript |  | 3.298 | 3.082 |  |  |  |  |  |
| macro/report | cpython |  | 0.0195 | 0.0194 |  |  |  | 14.8 KiB |  |
| macro/report | go-native |  | 0.00943 | 0.00934 |  |  |  | 8.8 KiB | 85 |
| macro/report | gopher-lua |  | 0.129 | 0.125 |  |  |  | 33.1 KiB | 1290 |
| macro/report | quickjs |  | 0.0460 | 0.0421 |  |  |  |  |  |
| macro/report | starlark-go |  | 0.0635 | 0.0627 |  |  |  | 66.2 KiB | 3084 |
| macro/report | ts-native |  | 0.00323 | 0.00308 |  |  |  | 2 B |  |
| macro/report | wasmoon |  | 0.0403 | 0.0342 |  |  |  |  |  |
| macro/transform | go | 30.2 | 0.784 | 0.777 | 20664 | 37.9 | 6.1 MiB | 480.7 KiB | 7555 |
| macro/transform | ts | 165.3 | 3.027 | 2.871 | 20664 | 146.5 | 6.1 MiB | 21.5 KiB |  |
| macro/transform | zig | 10.6 | 1.217 | 1.210 | 20664 | 58.9 | 6.1 MiB |  |  |
| macro/transform | applescript |  | 0.338 | 0.336 |  |  |  |  |  |
| macro/transform | cpython |  | 0.0188 | 0.0188 |  |  |  | 48.0 KiB |  |
| macro/transform | go-native |  | 0.000767 | 0.000744 |  |  |  | 7.4 KiB | 3 |
| macro/transform | gopher-lua |  | 0.132 | 0.131 |  |  |  | 268.0 KiB | 4538 |
| macro/transform | quickjs |  | 0.0609 | 0.0575 |  |  |  |  |  |
| macro/transform | starlark-go |  | 0.0569 | 0.0565 |  |  |  | 168.7 KiB | 328 |
| macro/transform | ts-native |  | 0.00360 | 0.00317 |  |  |  | 2 B |  |
| macro/transform | wasmoon |  | 0.0317 | 0.0247 |  |  |  |  |  |
| messaging/joins | go | 48.6 | 10.308 | 10.236 | 127218 | 81.0 | 239.1 KiB | 15.8 MiB | 189229 |
| messaging/joins | ts | 227.1 | 21.072 | 19.366 | 127218 | 165.6 | 239.1 KiB | 51.4 KiB |  |
| messaging/parents | go | 25.0 | 7.961 | 7.909 | 67518 | 117.9 | 93.8 KiB | 12.4 MiB | 191768 |
| messaging/parents | ts | 147.0 | 15.269 | 14.649 | 67518 | 226.1 | 93.8 KiB | 55.0 KiB |  |
| messaging/sends | go | 44.5 | 6.571 | 6.503 | 67518 | 97.3 | 93.8 KiB | 10.6 MiB | 146767 |
| messaging/sends | ts | 171.0 | 16.339 | 15.586 | 67518 | 242.0 | 93.8 KiB | 656.8 KiB |  |
| messaging/suspend | go | 24.6 | 9.117 | 9.048 | 48018 | 189.9 | 31.3 KiB | 11.3 MiB | 322029 |
| messaging/suspend | ts | 98.0 | 16.752 | 15.887 | 48018 | 348.9 | 31.3 KiB | 398.8 KiB |  |
| messaging/suspend | zig | 6.4 | 7.752 | 7.699 | 48018 | 161.4 | 31.3 KiB |  |  |
| numbers/add | go | 21.2 | 1.365 | 1.363 | 26030 | 52.4 | 31.4 KiB | 500.8 KiB | 10054 |
| numbers/add | ts | 115.5 | 2.376 | 2.206 | 26030 | 91.3 | 31.4 KiB | 237.3 KiB |  |
| numbers/add | zig | 6.5 | 1.728 | 1.716 | 26030 | 66.4 | 31.4 KiB |  |  |
| numbers/add | applescript |  | 0.227 | 0.226 |  |  |  |  |  |
| numbers/add | cpython |  | 0.0203 | 0.0200 |  |  |  | 0 B |  |
| numbers/add | go-native |  | 0.00122 | 0.00115 |  |  |  | 8 B | 1 |
| numbers/add | gopher-lua |  | 0.0297 | 0.0293 |  |  |  | 43.9 KiB | 177 |
| numbers/add | quickjs |  | 0.0220 | 0.0201 |  |  |  |  |  |
| numbers/add | starlark-go |  | 0.0488 | 0.0482 |  |  |  | 15.9 KiB | 2010 |
| numbers/add | ts-native |  | 0.00117 | 0.00112 |  |  |  | 0 B |  |
| numbers/add | wasmoon |  | 0.00714 | 0.00687 |  |  |  |  |  |
| numbers/divide | go | 21.5 | 2.451 | 2.437 | 18031 | 135.9 | 31.4 KiB | 3.2 MiB | 115942 |
| numbers/divide | ts | 86.2 | 2.123 | 2.028 | 18031 | 117.7 | 31.4 KiB | 438.1 KiB |  |
| numbers/divide | zig | 6.6 | 1.514 | 1.507 | 18031 | 84.0 | 31.4 KiB |  |  |
| numbers/divide | applescript |  | 0.195 | 0.193 |  |  |  |  |  |
| numbers/divide | cpython |  | 0.0156 | 0.0155 |  |  |  | 0 B |  |
| numbers/divide | go-native |  | 0.000754 | 0.000752 |  |  |  | 8 B | 1 |
| numbers/divide | gopher-lua |  | 0.0220 | 0.0218 |  |  |  | 28.3 KiB | 115 |
| numbers/divide | quickjs |  | 0.0216 | 0.0211 |  |  |  |  |  |
| numbers/divide | starlark-go |  | 0.0420 | 0.0414 |  |  |  | 15.9 KiB | 2010 |
| numbers/divide | ts-native |  | 0.000618 | 0.000595 |  |  |  | 0 B |  |
| numbers/divide | wasmoon |  | 0.00594 | 0.00585 |  |  |  |  |  |
| numbers/multiply | go | 22.3 | 0.890 | 0.888 | 18031 | 49.4 | 31.4 KiB | 306.7 KiB | 7053 |
| numbers/multiply | ts | 91.4 | 1.485 | 1.380 | 18031 | 82.4 | 31.4 KiB | 228.7 KiB |  |
| numbers/multiply | zig | 6.8 | 1.793 | 1.478 | 18031 | 99.4 | 31.4 KiB |  |  |
| numbers/multiply | applescript |  | 0.172 | 0.172 |  |  |  |  |  |
| numbers/multiply | cpython |  | 0.0156 | 0.0154 |  |  |  | 0 B |  |
| numbers/multiply | go-native |  | 0.000753 | 0.000753 |  |  |  | 8 B | 1 |
| numbers/multiply | gopher-lua |  | 0.0203 | 0.0200 |  |  |  | 29.1 KiB | 118 |
| numbers/multiply | quickjs |  | 0.0282 | 0.0267 |  |  |  |  |  |
| numbers/multiply | starlark-go |  | 0.0399 | 0.0394 |  |  |  | 15.9 KiB | 2010 |
| numbers/multiply | ts-native |  | 0.000618 | 0.000595 |  |  |  | 0 B |  |
| numbers/multiply | wasmoon |  | 0.00651 | 0.00626 |  |  |  |  |  |
| numbers/quantity | go | 27.1 | 4.158 | 4.153 | 14579 | 285.2 | 39.1 KiB | 4.8 MiB | 190395 |
| numbers/quantity | ts | 152.1 | 4.171 | 3.890 | 14579 | 286.1 | 39.1 KiB | 446.2 KiB |  |
| numbers/quantity | zig | 8.3 | 2.713 | 2.705 | 14579 | 186.1 | 39.1 KiB |  |  |
| numbers/quantity | applescript |  | 0.118 | 0.116 |  |  |  |  |  |
| numbers/quantity | cpython |  | 0.0104 | 0.0103 |  |  |  | 0 B |  |
| numbers/quantity | go-native |  | 0.000262 | 0.000262 |  |  |  | 8 B | 1 |
| numbers/quantity | gopher-lua |  | 0.0126 | 0.0125 |  |  |  | 16.5 KiB | 67 |
| numbers/quantity | quickjs |  | 0.00914 | 0.00906 |  |  |  |  |  |
| numbers/quantity | starlark-go |  | 0.0266 | 0.0262 |  |  |  | 8.1 KiB | 1009 |
| numbers/quantity | ts-native |  | 0.000353 | 0.000339 |  |  |  | 0 B |  |
| numbers/quantity | wasmoon |  | 0.00450 | 0.00404 |  |  |  |  |  |
| text/build | go | 18.5 | 0.543 | 0.541 | 28928 | 18.8 | 374.8 KiB | 536.2 KiB | 2530 |
| text/build | ts | 95.4 | 1.099 | 1.037 | 28928 | 38.0 | 374.8 KiB | 192.4 KiB |  |
| text/build | zig | 5.7 | 0.479 | 0.477 | 28928 | 16.6 | 374.8 KiB |  |  |
| text/build | applescript |  | 0.364 | 0.361 |  |  |  |  |  |
| text/build | cpython |  | 0.0102 | 0.0101 |  |  |  | 1.5 KiB |  |
| text/build | go-native |  | 0.0444 | 0.0436 |  |  |  | 387.1 KiB | 500 |
| text/build | gopher-lua |  | 0.0644 | 0.0620 |  |  |  | 400.8 KiB | 1024 |
| text/build | quickjs |  | 0.0224 | 0.0212 |  |  |  |  |  |
| text/build | starlark-go |  | 0.0594 | 0.0583 |  |  |  | 395.1 KiB | 1006 |
| text/build | ts-native |  | 0.00164 | 0.00130 |  |  |  | 18 B |  |
| text/build | wasmoon |  | 0.0407 | 0.0393 |  |  |  |  |  |
| text/graphemes | go | 23.0 | 2.549 | 2.541 | 43518 | 58.6 | 144.1 KiB | 1.1 MiB | 27918 |
| text/graphemes | ts | 107.5 | 5.762 | 5.313 | 43518 | 132.4 | 144.1 KiB | 640.3 KiB |  |
| text/graphemes | zig | 7.2 | 2.500 | 2.491 | 43518 | 57.4 | 144.1 KiB |  |  |
| text/index | go | 24.2 | 4.035 | 3.999 | 26640 | 151.5 | 49.9 KiB | 5.1 MiB | 158688 |
| text/index | ts | 130.0 | 7.080 | 6.251 | 26640 | 265.8 | 49.9 KiB | 770.2 KiB |  |
| text/index | zig | 7.6 | 2.031 | 2.022 | 26640 | 76.2 | 49.9 KiB |  |  |
| text/index | applescript |  | 0.848 | 0.839 |  |  |  |  |  |
| text/index | cpython |  | 0.0170 | 0.0164 |  |  |  | 0 B |  |
| text/index | go-native |  | 0.000402 | 0.000400 |  |  |  | 0 B | 0 |
| text/index | gopher-lua |  | 0.121 | 0.119 |  |  |  | 29.3 KiB | 1055 |
| text/index | quickjs |  | 0.0455 | 0.0422 |  |  |  |  |  |
| text/index | starlark-go |  | 0.0530 | 0.0523 |  |  |  | 15.9 KiB | 1006 |
| text/index | ts-native |  | 0.000849 | 0.000756 |  |  |  | 0 B |  |
| text/index | wasmoon |  | 0.0336 | 0.0303 |  |  |  |  |  |
| text/iterate | go | 21.7 | 1.498 | 1.489 | 30318 | 49.4 | 93.0 KiB | 740.5 KiB | 14718 |
| text/iterate | ts | 112.1 | 3.553 | 3.339 | 30318 | 117.2 | 93.0 KiB | 1.1 MiB |  |
| text/iterate | zig | 6.9 | 1.601 | 1.595 | 30318 | 52.8 | 93.0 KiB |  |  |
| text/iterate | applescript |  | 3.279 | 3.219 |  |  |  |  |  |
| text/iterate | cpython |  | 0.0196 | 0.0189 |  |  |  | 48 B |  |
| text/iterate | go-native |  | 0.000494 | 0.000483 |  |  |  | 8 B | 1 |
| text/iterate | gopher-lua |  | 0.186 | 0.184 |  |  |  | 187.3 KiB | 9847 |
| text/iterate | quickjs |  | 0.0613 | 0.0564 |  |  |  |  |  |
| text/iterate | starlark-go |  | 0.117 | 0.116 |  |  |  | 62.0 KiB | 3607 |
| text/iterate | ts-native |  | 0.00122 | 0.00119 |  |  |  | 0 B |  |
| text/iterate | wasmoon |  | 0.0468 | 0.0414 |  |  |  |  |  |
| text/patterns | go | 22.4 | 3.070 | 3.027 | 13818 | 222.2 | 225.9 KiB | 6.0 MiB | 63288 |
| text/patterns | ts | 129.8 | 5.767 | 5.393 | 13818 | 417.4 | 225.9 KiB | 1.9 MiB |  |
| text/patterns | zig | 7.2 | 0.848 | 0.845 | 13818 | 61.4 | 225.9 KiB |  |  |
| text/patterns | applescript |  | 15.279 | 15.181 |  |  |  |  |  |
| text/patterns | cpython |  | 0.0500 | 0.0492 |  |  |  | 1.2 KiB |  |
| text/patterns | go-native |  | 0.0648 | 0.0643 |  |  |  | 37.8 KiB | 1201 |
| text/patterns | gopher-lua |  | 0.271 | 0.269 |  |  |  | 390.8 KiB | 17736 |
| text/patterns | quickjs |  | 0.233 | 0.219 |  |  |  |  |  |
| text/patterns | starlark-go |  | 0.198 | 0.196 |  |  |  | 87.0 KiB | 4507 |
| text/patterns | ts-native |  | 0.0172 | 0.0157 |  |  |  | 28 B |  |
| text/patterns | wasmoon |  | 0.0608 | 0.0583 |  |  |  |  |  |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- numbers/quantity on zig: 186.1 ns/Fuel, 3.1× the median
- collections/map-build on zig: 407.2 ns/Fuel, 6.9× the median
- host/pump on zig: 302.1 ns/Fuel, 5.1× the median
- lifecycle/load-small on zig: 242.3 ns/Fuel, 4.1× the median
- text/patterns on ts: 417.4 ns/Fuel, 3.2× the median
- host/pump on ts: 986.3 ns/Fuel, 7.6× the median
- lifecycle/load-small on ts: 1032.2 ns/Fuel, 8.0× the median
- lifecycle/rollback on ts: 1020.5 ns/Fuel, 7.9× the median
- numbers/quantity on go: 285.2 ns/Fuel, 5.0× the median
- text/patterns on go: 222.2 ns/Fuel, 3.9× the median
- host/pump on go: 442.9 ns/Fuel, 7.8× the median
- messaging/suspend on go: 189.9 ns/Fuel, 3.3× the median
- lifecycle/load-small on go: 439.1 ns/Fuel, 7.7× the median

## Skipped

- core/fib@slice=10 on peers: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=100 on peers: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=1000 on peers: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10000 on peers: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- text/graphemes on peers: Unicode grapheme segmentation has no shared API across the pinned peers; text/iterate and text/index compare ASCII.
- host/immediate on zig: The native benchmark Host does not yet install immediate bindings; this is a runner limitation, not a Core limitation.
- host/immediate on peers: NorthTalk embedding API; no peer counterpart.
- host/suspending on zig: The native benchmark Host does not yet install suspending bindings; this is a runner limitation, not a Core limitation.
- host/suspending on peers: NorthTalk embedding API; no peer counterpart.
- host/properties on zig: The native benchmark Host does not yet install properties bindings; this is a runner limitation, not a Core limitation.
- host/properties on peers: NorthTalk embedding API; no peer counterpart.
- host/conversion on zig: The native benchmark Host does not yet install conversion bindings; this is a runner limitation, not a Core limitation.
- host/conversion on peers: NorthTalk embedding API; no peer counterpart.
- host/pump on peers: NorthTalk embedding API; no peer counterpart.
- messaging/sends on zig: The native benchmark Host does not yet install partner bindings; this is a runner limitation, not a Core limitation.
- messaging/sends on peers: NorthTalk embedding API; no peer counterpart.
- messaging/parents on zig: The native benchmark Host does not yet install parents bindings; this is a runner limitation, not a Core limitation.
- messaging/parents on peers: NorthTalk embedding API; no peer counterpart.
- messaging/joins on zig: The native benchmark Host does not yet install partner bindings; this is a runner limitation, not a Core limitation.
- messaging/joins on peers: NorthTalk embedding API; no peer counterpart.
- messaging/suspend on peers: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-small on peers: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-large on peers: NorthTalk embedding API; no peer counterpart.
- lifecycle/restore on zig: The native benchmark Host does not yet install restore bindings; this is a runner limitation, not a Core limitation.
- lifecycle/restore on peers: NorthTalk embedding API; no peer counterpart.
- lifecycle/rollback on zig: The native benchmark Host does not yet install suspending bindings; this is a runner limitation, not a Core limitation.
- lifecycle/rollback on peers: NorthTalk embedding API; no peer counterpart.
