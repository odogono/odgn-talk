# Benchmark results, 2026-11-06

Commit `2ddafe4` on AMD EPYC 7763 64-Core Processor (4 cores, 16 GiB), linux x64.
Versions: bun 1.4.2, zig 0.17.0, zig build native safe; C Host zig cc -O2, cost model 0, go go1.27.3, language 1.0-rc.3, cpython 3.14.8, gopher-lua v1.1.2, quickjs-emscripten 0.32.0, starlark-go v0.0.0-20261005163335-bcb1a1a55bf9, wasmoon 1.16.0.
Settings: count 10, runners go,ts,zig,quickjs,ts-native,wasmoon,go-native,gopher-lua,starlark-go,cpython,applescript, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | go | 243.6 | 1.924 | 1.919 | 89459 | 21.5 | 195.6 KiB | 11.2 KiB | 155 |
| collections/iterate | ts | 558.9 | 2.873 | 2.676 | 89459 | 32.1 | 195.6 KiB | 407.5 KiB |  |
| collections/iterate | zig | 45.0 | 0.533 | 0.532 | 89459 | 6.0 | 195.6 KiB |  |  |
| collections/iterate | cpython |  | 0.131 | 0.131 |  |  |  | 2.5 KiB |  |
| collections/iterate | go-native |  | 0.0370 | 0.0370 |  |  |  | 1.8 KiB | 4 |
| collections/iterate | gopher-lua |  | 0.962 | 0.959 |  |  |  | 108.9 KiB | 6741 |
| collections/iterate | quickjs |  | 0.431 | 0.420 |  |  |  |  |  |
| collections/iterate | starlark-go |  | 0.515 | 0.513 |  |  |  | 270.5 KiB | 783 |
| collections/iterate | ts-native |  | 0.0174 | 0.0168 |  |  |  | 1.2 KiB |  |
| collections/iterate | wasmoon |  | 0.388 | 0.371 |  |  |  |  |  |
| collections/list-append | go | 210.1 | 3.348 | 3.329 | 52056 | 64.3 | 78.3 KiB | 21.0 KiB | 120 |
| collections/list-append | ts | 577.0 | 5.533 | 3.330 | 52056 | 106.3 | 78.3 KiB | 1.4 MiB |  |
| collections/list-append | zig | 33.9 | 0.782 | 0.759 | 52056 | 15.0 | 78.3 KiB |  |  |
| collections/list-append | cpython |  | 0.0844 | 0.0843 |  |  |  | 67.2 KiB |  |
| collections/list-append | go-native |  | 0.00461 | 0.00454 |  |  |  | 16.0 KiB | 2 |
| collections/list-append | gopher-lua |  | 0.474 | 0.469 |  |  |  | 203.9 KiB | 4315 |
| collections/list-append | quickjs |  | 0.330 | 0.320 |  |  |  |  |  |
| collections/list-append | starlark-go |  | 0.468 | 0.465 |  |  |  | 223.8 KiB | 4027 |
| collections/list-append | ts-native |  | 0.00976 | 0.00936 |  |  |  | 222 B |  |
| collections/list-append | wasmoon |  | 0.179 | 0.172 |  |  |  |  |  |
| collections/list-build | go | 173.7 | 0.609 | 0.607 | 19091 | 31.9 | 2.9 MiB | 9.5 KiB | 107 |
| collections/list-build | ts | 389.1 | 1.273 | 0.795 | 19091 | 66.7 | 2.9 MiB | 293.5 KiB |  |
| collections/list-build | zig | 23.4 | 0.138 | 0.138 | 19091 | 7.2 | 2.9 MiB |  |  |
| collections/list-build | cpython |  | 0.0170 | 0.0170 |  |  |  | 8.6 KiB |  |
| collections/list-build | go-native |  | 0.00139 | 0.00135 |  |  |  | 4.0 KiB | 2 |
| collections/list-build | gopher-lua |  | 0.0986 | 0.0979 |  |  |  | 35.4 KiB | 1045 |
| collections/list-build | quickjs |  | 0.0809 | 0.0795 |  |  |  |  |  |
| collections/list-build | starlark-go |  | 0.0547 | 0.0544 |  |  |  | 18.7 KiB | 18 |
| collections/list-build | ts-native |  | 0.00208 | 0.00200 |  |  |  | 15 B |  |
| collections/list-build | wasmoon |  | 0.0393 | 0.0356 |  |  |  |  |  |
| collections/list-update | go | 206.3 | 1.232 | 1.230 | 28553 | 43.2 | 23.8 KiB | 8.2 KiB | 121 |
| collections/list-update | ts | 471.4 | 3.233 | 3.071 | 28553 | 113.2 | 23.8 KiB | 670.2 KiB |  |
| collections/list-update | zig | 34.0 | 0.265 | 0.265 | 28553 | 9.3 | 23.8 KiB |  |  |
| collections/list-update | cpython |  | 0.0207 | 0.0207 |  |  |  | 184 B |  |
| collections/list-update | go-native |  | 0.000534 | 0.000533 |  |  |  | 72 B | 2 |
| collections/list-update | gopher-lua |  | 0.0681 | 0.0679 |  |  |  | 22.4 KiB | 106 |
| collections/list-update | quickjs |  | 0.0667 | 0.0652 |  |  |  |  |  |
| collections/list-update | starlark-go |  | 0.0924 | 0.0911 |  |  |  | 704 B | 13 |
| collections/list-update | ts-native |  | 0.00193 | 0.00192 |  |  |  | 122 B |  |
| collections/list-update | wasmoon |  | 0.0186 | 0.0171 |  |  |  |  |  |
| collections/map-build | go | 200.3 | 1.601 | 1.597 | 14094 | 113.6 | 24.3 KiB | 13.3 KiB | 107 |
| collections/map-build | ts | 497.4 | 1.671 | 1.302 | 14094 | 118.5 | 24.3 KiB | 314.8 KiB |  |
| collections/map-build | zig | 30.6 | 0.397 | 0.392 | 14094 | 28.2 | 24.3 KiB |  |  |
| collections/map-build | cpython |  | 0.0335 | 0.0334 |  |  |  | 19.3 KiB |  |
| collections/map-build | go-native |  | 0.0160 | 0.0159 |  |  |  | 13.9 KiB | 205 |
| collections/map-build | gopher-lua |  | 0.216 | 0.215 |  |  |  | 90.5 KiB | 1291 |
| collections/map-build | quickjs |  | 0.0949 | 0.0924 |  |  |  |  |  |
| collections/map-build | starlark-go |  | 0.108 | 0.107 |  |  |  | 99.4 KiB | 827 |
| collections/map-build | ts-native |  | 0.0114 | 0.0107 |  |  |  | 172 B |  |
| collections/map-build | wasmoon |  | 0.124 | 0.117 |  |  |  |  |  |
| collections/map-update | go | 222.2 | 0.529 | 0.527 | 8056 | 65.7 | 12.1 KiB | 6.9 KiB | 106 |
| collections/map-update | ts | 460.5 | 2.188 | 2.103 | 8056 | 271.6 | 12.1 KiB | 367.8 KiB |  |
| collections/map-update | zig | 36.9 | 0.107 | 0.107 | 8056 | 13.3 | 12.1 KiB |  |  |
| collections/map-update | cpython |  | 0.00959 | 0.00958 |  |  |  | 480 B |  |
| collections/map-update | go-native |  | 0.00708 | 0.00706 |  |  |  | 520 B | 5 |
| collections/map-update | gopher-lua |  | 0.0478 | 0.0470 |  |  |  | 10.2 KiB | 76 |
| collections/map-update | quickjs |  | 0.0750 | 0.0697 |  |  |  |  |  |
| collections/map-update | starlark-go |  | 0.0401 | 0.0398 |  |  |  | 1.7 KiB | 11 |
| collections/map-update | ts-native |  | 0.00378 | 0.00375 |  |  |  | 5 B |  |
| collections/map-update | wasmoon |  | 0.0120 | 0.0104 |  |  |  |  |  |
| core/calls | go | 187.7 | 1.643 | 1.635 | 46018 | 35.7 | 31.3 KiB | 7.9 KiB | 118 |
| core/calls | ts | 327.7 | 1.864 | 1.766 | 46018 | 40.5 | 31.3 KiB | 55.1 KiB |  |
| core/calls | zig | 26.0 | 0.337 | 0.336 | 46018 | 7.3 | 31.3 KiB |  |  |
| core/calls | cpython |  | 0.0813 | 0.0810 |  |  |  | 0 B |  |
| core/calls | go-native |  | 0.000652 | 0.000652 |  |  |  | 8 B | 1 |
| core/calls | gopher-lua |  | 0.232 | 0.209 |  |  |  | 44.8 KiB | 180 |
| core/calls | quickjs |  | 0.219 | 0.216 |  |  |  |  |  |
| core/calls | starlark-go |  | 0.339 | 0.338 |  |  |  | 125.3 KiB | 2006 |
| core/calls | ts-native |  | 0.000940 | 0.000936 |  |  |  | 3 B |  |
| core/calls | wasmoon |  | 0.0852 | 0.0823 |  |  |  |  |  |
| core/fib | go | 177.6 | 1.544 | 1.542 | 46365 | 33.3 | 46.2 KiB | 7.9 KiB | 117 |
| core/fib | ts | 361.6 | 1.452 | 1.372 | 46365 | 31.3 | 46.2 KiB | 23.2 KiB |  |
| core/fib | zig | 23.7 | 0.365 | 0.362 | 46365 | 7.9 | 46.2 KiB |  |  |
| core/fib | cpython |  | 0.0626 | 0.0624 |  |  |  | 0 B |  |
| core/fib | go-native |  | 0.00354 | 0.00354 |  |  |  | 8 B | 1 |
| core/fib | gopher-lua |  | 0.183 | 0.182 |  |  |  | 63 B | 1 |
| core/fib | quickjs |  | 0.151 | 0.148 |  |  |  |  |  |
| core/fib | starlark-go |  | 0.384 | 0.382 |  |  |  | 154.2 KiB | 1975 |
| core/fib | ts-native |  | 0.00405 | 0.00404 |  |  |  | 1 B |  |
| core/fib | wasmoon |  | 0.0829 | 0.0796 |  |  |  |  |  |
| core/fib@slice=10 | go | 176.7 | 54.931 | 54.510 | 46365 | 1184.7 | 46.2 KiB | 9.5 MiB | 134554 |
| core/fib@slice=10 | ts | 291.9 | 16.846 | 15.173 | 46365 | 363.3 | 46.2 KiB | 380.6 KiB |  |
| core/fib@slice=10 | zig | 23.5 | 2.997 | 2.988 | 46365 | 64.6 | 46.2 KiB |  |  |
| core/fib@slice=100 | go | 176.6 | 7.260 | 7.212 | 46365 | 156.6 | 46.2 KiB | 985.8 KiB | 13544 |
| core/fib@slice=100 | ts | 244.5 | 3.062 | 2.858 | 46365 | 66.0 | 46.2 KiB | 28.0 KiB |  |
| core/fib@slice=100 | zig | 23.3 | 0.656 | 0.653 | 46365 | 14.1 | 46.2 KiB |  |  |
| core/fib@slice=1000 | go | 175.4 | 2.187 | 2.170 | 46365 | 47.2 | 46.2 KiB | 105.5 KiB | 1451 |
| core/fib@slice=1000 | ts | 232.2 | 1.616 | 1.522 | 46365 | 34.8 | 46.2 KiB | 20.4 KiB |  |
| core/fib@slice=1000 | zig | 23.3 | 0.391 | 0.389 | 46365 | 8.4 | 46.2 KiB |  |  |
| core/fib@slice=10000 | go | 175.7 | 1.632 | 1.623 | 46365 | 35.2 | 46.2 KiB | 16.6 KiB | 233 |
| core/fib@slice=10000 | ts | 232.1 | 1.427 | 1.369 | 46365 | 30.8 | 46.2 KiB | 9.9 KiB |  |
| core/fib@slice=10000 | zig | 23.8 | 0.356 | 0.355 | 46365 | 7.7 | 46.2 KiB |  |  |
| core/lambdas | go | 197.7 | 2.249 | 2.244 | 58027 | 38.8 | 62.6 KiB | 8.6 KiB | 126 |
| core/lambdas | ts | 396.4 | 3.373 | 2.927 | 58027 | 58.1 | 62.6 KiB | 202.0 KiB |  |
| core/lambdas | zig | 30.4 | 0.480 | 0.479 | 58027 | 8.3 | 62.6 KiB |  |  |
| core/lambdas | cpython |  | 0.106 | 0.106 |  |  |  | 208 B |  |
| core/lambdas | go-native |  | 0.00128 | 0.00128 |  |  |  | 8 B | 1 |
| core/lambdas | gopher-lua |  | 0.254 | 0.252 |  |  |  | 60.3 KiB | 244 |
| core/lambdas | quickjs |  | 0.237 | 0.234 |  |  |  |  |  |
| core/lambdas | starlark-go |  | 0.417 | 0.415 |  |  |  | 156.6 KiB | 2010 |
| core/lambdas | ts-native |  | 0.00173 | 0.00172 |  |  |  | 32 B |  |
| core/lambdas | wasmoon |  | 0.129 | 0.125 |  |  |  |  |  |
| core/loop | go | 171.9 | 0.816 | 0.813 | 48016 | 17.0 | 62.5 KiB | 9.1 KiB | 134 |
| core/loop | ts | 449.2 | 1.031 | 1.003 | 48016 | 21.5 | 62.5 KiB | 108.0 KiB |  |
| core/loop | zig | 29.3 | 0.246 | 0.245 | 48016 | 5.1 | 62.5 KiB |  |  |
| core/loop | cpython |  | 0.0395 | 0.0395 |  |  |  | 0 B |  |
| core/loop | go-native |  | 0.000652 | 0.000651 |  |  |  | 8 B | 1 |
| core/loop | gopher-lua |  | 0.0683 | 0.0680 |  |  |  | 44.8 KiB | 180 |
| core/loop | quickjs |  | 0.0732 | 0.0725 |  |  |  |  |  |
| core/loop | starlark-go |  | 0.126 | 0.121 |  |  |  | 256 B | 6 |
| core/loop | ts-native |  | 0.000938 | 0.000936 |  |  |  | 2 B |  |
| core/loop | wasmoon |  | 0.0190 | 0.0177 |  |  |  |  |  |
| host/conversion | go | 308.3 | 22.526 | 22.336 | 25018 | 900.4 | 220.3 KiB | 3.7 MiB | 63491 |
| host/conversion | ts | 434.0 | 18.062 | 15.976 | 25018 | 722.0 | 220.3 KiB | 683.8 KiB |  |
| host/immediate | go | 287.1 | 7.300 | 7.254 | 13518 | 540.0 | 15.7 KiB | 1.1 MiB | 14623 |
| host/immediate | ts | 473.9 | 4.935 | 4.260 | 13518 | 365.1 | 15.7 KiB | 847.0 KiB |  |
| host/properties | go | 604.1 | 4.323 | 4.295 | 9018 | 479.4 | 15.7 KiB | 815.7 KiB | 9879 |
| host/properties | ts | 389.0 | 3.062 | 1.738 | 9018 | 339.5 | 15.7 KiB | 302.8 KiB |  |
| host/pump | go | 105.1 | 0.0471 | 0.0468 | 7 | 6723.1 | 0 B | 6.2 KiB | 94 |
| host/pump | ts | 113.5 | 0.0145 | 0.0118 | 7 | 2071.2 | 0 B | 768 B |  |
| host/pump | zig | 7.0 | 0.00194 | 0.00193 | 7 | 277.5 | 0 B |  |  |
| host/suspending | go | 291.3 | 29.892 | 29.812 | 13518 | 2211.3 | 15.7 KiB | 2.6 MiB | 40485 |
| host/suspending | ts | 464.8 | 21.537 | 16.759 | 13518 | 1593.2 | 15.7 KiB | 2.5 MiB |  |
| lifecycle/load-large | go | 5364.3 | 0.474 | 0.472 | 4609 | 102.9 | 16.3 KiB | 6.7 KiB | 99 |
| lifecycle/load-large | ts | 22871.2 | 0.683 | 0.639 | 4609 | 148.2 | 16.3 KiB | 49.3 KiB |  |
| lifecycle/load-large | zig | 2825.5 | 0.102 | 0.101 | 4609 | 22.1 | 16.3 KiB |  |  |
| lifecycle/load-small | go | 117.2 | 0.0469 | 0.0466 | 7 | 6696.7 | 0 B | 6.4 KiB | 95 |
| lifecycle/load-small | ts | 161.7 | 0.0207 | 0.0179 | 7 | 2953.5 | 0 B | 2.2 KiB |  |
| lifecycle/load-small | zig | 8.8 | 0.00329 | 0.00327 | 7 | 469.5 | 0 B |  |  |
| lifecycle/restore | go | 257.1 | 6.264 | 5.994 | 8015 | 781.5 | 7.8 KiB | 7.2 MiB | 1163 |
| lifecycle/restore | ts | 550.6 | 7.291 | 6.088 | 8015 | 909.7 | 7.8 KiB | 1.5 MiB |  |
| lifecycle/rollback | go | 381.6 | 206.869 | 206.288 | 102023 | 2027.7 | 39.9 KiB | 21.8 MiB | 284000 |
| lifecycle/rollback | ts | 723.8 | 177.334 | 168.560 | 102023 | 1738.2 | 39.9 KiB | 11.5 MiB |  |
| macro/game-tick | go | 244.8 | 2.897 | 2.889 | 67042 | 43.2 | 78.4 KiB | 9.0 KiB | 131 |
| macro/game-tick | ts | 513.0 | 13.987 | 13.611 | 67042 | 208.6 | 78.4 KiB | 468.4 KiB |  |
| macro/game-tick | zig | 43.2 | 0.613 | 0.611 | 67042 | 9.1 | 78.4 KiB |  |  |
| macro/game-tick | cpython |  | 0.126 | 0.126 |  |  |  | 0 B |  |
| macro/game-tick | go-native |  | 0.000340 | 0.000339 |  |  |  | 8 B | 1 |
| macro/game-tick | gopher-lua |  | 0.338 | 0.336 |  |  |  | 28.7 KiB | 128 |
| macro/game-tick | quickjs |  | 0.172 | 0.167 |  |  |  |  |  |
| macro/game-tick | starlark-go |  | 0.460 | 0.457 |  |  |  | 94.5 KiB | 1007 |
| macro/game-tick | ts-native |  | 0.000713 | 0.000710 |  |  |  | 42 B |  |
| macro/game-tick | wasmoon |  | 0.0990 | 0.0858 |  |  |  |  |  |
| macro/report | go | 187.5 | 3.359 | 3.345 | 86555 | 38.8 | 1.2 MiB | 6.5 KiB | 102 |
| macro/report | ts | 322.6 | 2.759 | 2.093 | 86555 | 31.9 | 1.2 MiB | 1.0 MiB |  |
| macro/report | zig | 25.6 | 0.987 | 0.977 | 86555 | 11.4 | 1.2 MiB |  |  |
| macro/report | cpython |  | 0.0528 | 0.0524 |  |  |  | 14.8 KiB |  |
| macro/report | go-native |  | 0.0228 | 0.0226 |  |  |  | 8.8 KiB | 85 |
| macro/report | gopher-lua |  | 0.349 | 0.347 |  |  |  | 33.1 KiB | 1291 |
| macro/report | quickjs |  | 0.115 | 0.110 |  |  |  |  |  |
| macro/report | starlark-go |  | 0.165 | 0.164 |  |  |  | 66.2 KiB | 3084 |
| macro/report | ts-native |  | 0.00862 | 0.00845 |  |  |  | 126 B |  |
| macro/report | wasmoon |  | 0.118 | 0.104 |  |  |  |  |  |
| macro/transform | go | 222.0 | 1.149 | 1.146 | 20664 | 55.6 | 6.1 MiB | 11.5 KiB | 108 |
| macro/transform | ts | 413.7 | 2.031 | 1.876 | 20664 | 98.3 | 6.1 MiB | 359.2 KiB |  |
| macro/transform | zig | 35.9 | 0.244 | 0.243 | 20664 | 11.8 | 6.1 MiB |  |  |
| macro/transform | cpython |  | 0.0419 | 0.0418 |  |  |  | 48.0 KiB |  |
| macro/transform | go-native |  | 0.00214 | 0.00210 |  |  |  | 7.4 KiB | 3 |
| macro/transform | gopher-lua |  | 0.350 | 0.347 |  |  |  | 268.0 KiB | 4538 |
| macro/transform | quickjs |  | 0.136 | 0.134 |  |  |  |  |  |
| macro/transform | starlark-go |  | 0.142 | 0.142 |  |  |  | 168.7 KiB | 328 |
| macro/transform | ts-native |  | 0.00523 | 0.00513 |  |  |  | 19 B |  |
| macro/transform | wasmoon |  | 0.106 | 0.0865 |  |  |  |  |  |
| messaging/joins | go | 328.4 | 30.875 | 30.368 | 127218 | 242.7 | 239.1 KiB | 6.9 MiB | 58558 |
| messaging/joins | ts | 648.2 | 64.889 | 62.540 | 127218 | 510.1 | 239.1 KiB | 4.5 MiB |  |
| messaging/parents | go | 765.7 | 18.965 | 18.846 | 67518 | 280.9 | 93.8 KiB | 3.8 MiB | 37427 |
| messaging/parents | ts | 451.2 | 49.481 | 47.825 | 67518 | 732.9 | 93.8 KiB | 1.7 MiB |  |
| messaging/sends | go | 306.4 | 19.448 | 19.272 | 67518 | 288.0 | 93.8 KiB | 3.6 MiB | 37425 |
| messaging/sends | ts | 515.7 | 32.929 | 29.944 | 67518 | 487.7 | 93.8 KiB | 5.9 MiB |  |
| messaging/suspend | go | 174.4 | 38.453 | 38.144 | 48018 | 800.8 | 31.3 KiB | 4.1 MiB | 58111 |
| messaging/suspend | ts | 341.9 | 24.623 | 21.340 | 48018 | 512.8 | 31.3 KiB | 3.5 MiB |  |
| messaging/suspend | zig | 21.3 | 2.844 | 2.837 | 48018 | 59.2 | 31.3 KiB |  |  |
| numbers/add | go | 177.9 | 0.482 | 0.480 | 26030 | 18.5 | 31.4 KiB | 7.2 KiB | 110 |
| numbers/add | ts | 306.2 | 0.903 | 0.869 | 26030 | 34.7 | 31.4 KiB | 42.5 KiB |  |
| numbers/add | zig | 22.1 | 0.131 | 0.130 | 26030 | 5.0 | 31.4 KiB |  |  |
| numbers/add | cpython |  | 0.0377 | 0.0376 |  |  |  | 0 B |  |
| numbers/add | go-native |  | 0.00188 | 0.00188 |  |  |  | 8 B | 1 |
| numbers/add | gopher-lua |  | 0.0709 | 0.0707 |  |  |  | 43.9 KiB | 177 |
| numbers/add | quickjs |  | 0.0718 | 0.0685 |  |  |  |  |  |
| numbers/add | starlark-go |  | 0.138 | 0.136 |  |  |  | 15.9 KiB | 2010 |
| numbers/add | ts-native |  | 0.00183 | 0.00183 |  |  |  | 0 B |  |
| numbers/add | wasmoon |  | 0.0241 | 0.0211 |  |  |  |  |  |
| numbers/divide | go | 177.1 | 0.621 | 0.620 | 18031 | 34.4 | 31.4 KiB | 7.2 KiB | 110 |
| numbers/divide | ts | 283.8 | 1.526 | 1.452 | 18031 | 84.6 | 31.4 KiB | 274.0 KiB |  |
| numbers/divide | zig | 24.5 | 0.116 | 0.116 | 18031 | 6.4 | 31.4 KiB |  |  |
| numbers/divide | cpython |  | 0.0327 | 0.0326 |  |  |  | 0 B |  |
| numbers/divide | go-native |  | 0.000954 | 0.000953 |  |  |  | 8 B | 1 |
| numbers/divide | gopher-lua |  | 0.0527 | 0.0524 |  |  |  | 28.3 KiB | 115 |
| numbers/divide | quickjs |  | 0.0606 | 0.0578 |  |  |  |  |  |
| numbers/divide | starlark-go |  | 0.121 | 0.121 |  |  |  | 15.9 KiB | 2010 |
| numbers/divide | ts-native |  | 0.000924 | 0.000921 |  |  |  | 0 B |  |
| numbers/divide | wasmoon |  | 0.0195 | 0.0173 |  |  |  |  |  |
| numbers/multiply | go | 184.3 | 0.488 | 0.487 | 18031 | 27.1 | 31.4 KiB | 7.2 KiB | 110 |
| numbers/multiply | ts | 343.6 | 0.611 | 0.584 | 18031 | 33.9 | 31.4 KiB | 39.3 KiB |  |
| numbers/multiply | zig | 22.7 | 0.0995 | 0.0993 | 18031 | 5.5 | 31.4 KiB |  |  |
| numbers/multiply | cpython |  | 0.0361 | 0.0360 |  |  |  | 0 B |  |
| numbers/multiply | go-native |  | 0.000954 | 0.000953 |  |  |  | 8 B | 1 |
| numbers/multiply | gopher-lua |  | 0.0493 | 0.0491 |  |  |  | 29.1 KiB | 118 |
| numbers/multiply | quickjs |  | 0.0809 | 0.0762 |  |  |  |  |  |
| numbers/multiply | starlark-go |  | 0.113 | 0.112 |  |  |  | 15.9 KiB | 2010 |
| numbers/multiply | ts-native |  | 0.000922 | 0.000920 |  |  |  | 0 B |  |
| numbers/multiply | wasmoon |  | 0.0220 | 0.0194 |  |  |  |  |  |
| numbers/quantity | go | 202.2 | 0.921 | 0.915 | 14579 | 63.2 | 39.1 KiB | 7.0 KiB | 108 |
| numbers/quantity | ts | 358.4 | 2.239 | 1.977 | 14579 | 153.6 | 39.1 KiB | 478.9 KiB |  |
| numbers/quantity | zig | 28.6 | 0.235 | 0.234 | 14579 | 16.1 | 39.1 KiB |  |  |
| numbers/quantity | cpython |  | 0.0225 | 0.0225 |  |  |  | 0 B |  |
| numbers/quantity | go-native |  | 0.000717 | 0.000716 |  |  |  | 8 B | 1 |
| numbers/quantity | gopher-lua |  | 0.0318 | 0.0317 |  |  |  | 16.5 KiB | 67 |
| numbers/quantity | quickjs |  | 0.0318 | 0.0316 |  |  |  |  |  |
| numbers/quantity | starlark-go |  | 0.0739 | 0.0736 |  |  |  | 8.1 KiB | 1009 |
| numbers/quantity | ts-native |  | 0.000599 | 0.000596 |  |  |  | 0 B |  |
| numbers/quantity | wasmoon |  | 0.0153 | 0.0127 |  |  |  |  |  |
| text/build | go | 171.8 | 0.545 | 0.544 | 28928 | 18.9 | 374.8 KiB | 6.6 KiB | 104 |
| text/build | ts | 253.1 | 0.834 | 0.777 | 28928 | 28.8 | 374.8 KiB | 164.7 KiB |  |
| text/build | zig | 19.7 | 0.0898 | 0.0892 | 28928 | 3.1 | 374.8 KiB |  |  |
| text/build | cpython |  | 0.0193 | 0.0192 |  |  |  | 1.5 KiB |  |
| text/build | go-native |  | 0.118 | 0.111 |  |  |  | 387.1 KiB | 500 |
| text/build | gopher-lua |  | 0.178 | 0.171 |  |  |  | 400.8 KiB | 1024 |
| text/build | quickjs |  | 0.0512 | 0.0504 |  |  |  |  |  |
| text/build | starlark-go |  | 0.159 | 0.153 |  |  |  | 395.1 KiB | 1006 |
| text/build | ts-native |  | 0.00168 | 0.00159 |  |  |  | 98 B |  |
| text/build | wasmoon |  | 0.0935 | 0.0894 |  |  |  |  |  |
| text/graphemes | go | 184.5 | 5.914 | 5.886 | 43518 | 135.9 | 144.1 KiB | 8.1 KiB | 120 |
| text/graphemes | ts | 429.4 | 4.957 | 4.365 | 43518 | 113.9 | 144.1 KiB | 1.4 MiB |  |
| text/graphemes | zig | 24.8 | 1.528 | 1.526 | 43518 | 35.1 | 144.1 KiB |  |  |
| text/index | go | 188.1 | 3.374 | 3.362 | 26640 | 126.6 | 49.9 KiB | 7.4 KiB | 113 |
| text/index | ts | 433.5 | 3.309 | 2.903 | 26640 | 124.2 | 49.9 KiB | 482.6 KiB |  |
| text/index | zig | 25.8 | 0.923 | 0.921 | 26640 | 34.7 | 49.9 KiB |  |  |
| text/index | cpython |  | 0.0368 | 0.0365 |  |  |  | 0 B |  |
| text/index | go-native |  | 0.00112 | 0.00112 |  |  |  | 0 B | 0 |
| text/index | gopher-lua |  | 0.244 | 0.244 |  |  |  | 29.3 KiB | 1055 |
| text/index | quickjs |  | 0.128 | 0.125 |  |  |  |  |  |
| text/index | starlark-go |  | 0.150 | 0.149 |  |  |  | 15.9 KiB | 1006 |
| text/index | ts-native |  | 0.00157 | 0.00156 |  |  |  | 0 B |  |
| text/index | wasmoon |  | 0.107 | 0.0996 |  |  |  |  |  |
| text/iterate | go | 180.1 | 2.131 | 2.124 | 30318 | 70.3 | 93.0 KiB | 7.6 KiB | 115 |
| text/iterate | ts | 297.3 | 2.427 | 2.211 | 30318 | 80.1 | 93.0 KiB | 504.0 KiB |  |
| text/iterate | zig | 23.7 | 0.489 | 0.487 | 30318 | 16.1 | 93.0 KiB |  |  |
| text/iterate | cpython |  | 0.0466 | 0.0464 |  |  |  | 48 B |  |
| text/iterate | go-native |  | 0.00109 | 0.00109 |  |  |  | 8 B | 1 |
| text/iterate | gopher-lua |  | 0.463 | 0.459 |  |  |  | 187.3 KiB | 9847 |
| text/iterate | quickjs |  | 0.158 | 0.153 |  |  |  |  |  |
| text/iterate | starlark-go |  | 0.327 | 0.326 |  |  |  | 62.0 KiB | 3607 |
| text/iterate | ts-native |  | 0.00236 | 0.00235 |  |  |  | 1 B |  |
| text/iterate | wasmoon |  | 0.140 | 0.128 |  |  |  |  |  |
| text/patterns | go | 187.7 | 4.300 | 4.283 | 13818 | 311.2 | 225.9 KiB | 6.7 KiB | 104 |
| text/patterns | ts | 449.7 | 9.653 | 8.566 | 13818 | 698.6 | 225.9 KiB | 1.4 MiB |  |
| text/patterns | zig | 25.4 | 1.303 | 1.299 | 13818 | 94.3 | 225.9 KiB |  |  |
| text/patterns | cpython |  | 0.130 | 0.129 |  |  |  | 1.2 KiB |  |
| text/patterns | go-native |  | 0.170 | 0.169 |  |  |  | 37.7 KiB | 1201 |
| text/patterns | gopher-lua |  | 0.719 | 0.714 |  |  |  | 390.8 KiB | 17736 |
| text/patterns | quickjs |  | 0.623 | 0.609 |  |  |  |  |  |
| text/patterns | starlark-go |  | 0.523 | 0.521 |  |  |  | 87.0 KiB | 4507 |
| text/patterns | ts-native |  | 0.0372 | 0.0370 |  |  |  | 876 B |  |
| text/patterns | wasmoon |  | 0.175 | 0.168 |  |  |  |  |  |
| tooling/lsp-reanalyse | ts |  | 42.770 | 36.691 |  |  |  | 19.5 MiB |  |

## Payload

What a browser Host ships to embed each Core: bundled with `Bun.build --target browser --minify`, compressed with `node:zlib`.

| Payload | Brotli | gzip -9 | Raw |
| - | -: | -: | -: |
| TS Core: Example Host | 185.4 KiB | 219.0 KiB | 746.1 KiB |
| TS Core: @northtalk/ts | 184.9 KiB | 218.2 KiB | 744.6 KiB |
| Zig Core: Example Host + talk.wasm | 926.0 KiB | 1.3 MiB | 4.0 MiB |
| Zig ÷ TS Example Host | 5.0× | 6.1× | 5.5× |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- core/fib@slice=10 on zig: 64.6 ns/Fuel, 5.6× the median
- text/patterns on zig: 94.3 ns/Fuel, 8.1× the median
- text/graphemes on zig: 35.1 ns/Fuel, 3.0× the median
- host/pump on zig: 277.5 ns/Fuel, 23.9× the median
- messaging/suspend on zig: 59.2 ns/Fuel, 5.1× the median
- lifecycle/load-small on zig: 469.5 ns/Fuel, 40.5× the median
- core/fib@slice=10 on ts: 363.3 ns/Fuel, 3.1× the median
- text/patterns on ts: 698.6 ns/Fuel, 6.0× the median
- host/immediate on ts: 365.1 ns/Fuel, 3.1× the median
- host/suspending on ts: 1593.2 ns/Fuel, 13.7× the median
- host/conversion on ts: 722.0 ns/Fuel, 6.2× the median
- host/pump on ts: 2071.2 ns/Fuel, 17.8× the median
- messaging/sends on ts: 487.7 ns/Fuel, 4.2× the median
- messaging/parents on ts: 732.9 ns/Fuel, 6.3× the median
- messaging/joins on ts: 510.1 ns/Fuel, 4.4× the median
- messaging/suspend on ts: 512.8 ns/Fuel, 4.4× the median
- lifecycle/load-small on ts: 2953.5 ns/Fuel, 25.4× the median
- lifecycle/rollback on ts: 1738.2 ns/Fuel, 15.0× the median
- core/fib@slice=10 on go: 1184.7 ns/Fuel, 17.4× the median
- text/patterns on go: 311.2 ns/Fuel, 4.6× the median
- host/immediate on go: 540.0 ns/Fuel, 7.9× the median
- host/suspending on go: 2211.3 ns/Fuel, 32.5× the median
- host/properties on go: 479.4 ns/Fuel, 7.1× the median
- host/conversion on go: 900.4 ns/Fuel, 13.2× the median
- host/pump on go: 6723.1 ns/Fuel, 98.9× the median
- messaging/sends on go: 288.0 ns/Fuel, 4.2× the median
- messaging/parents on go: 280.9 ns/Fuel, 4.1× the median
- messaging/joins on go: 242.7 ns/Fuel, 3.6× the median
- messaging/suspend on go: 800.8 ns/Fuel, 11.8× the median
- lifecycle/load-small on go: 6696.7 ns/Fuel, 98.5× the median
- lifecycle/rollback on go: 2027.7 ns/Fuel, 29.8× the median

## Skipped

- core/fib@slice=10 on quickjs: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10 on ts-native: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10 on wasmoon: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10 on go-native: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10 on gopher-lua: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10 on starlark-go: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10 on cpython: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10 on applescript: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=100 on quickjs: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=100 on ts-native: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=100 on wasmoon: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=100 on go-native: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=100 on gopher-lua: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=100 on starlark-go: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=100 on cpython: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=100 on applescript: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=1000 on quickjs: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=1000 on ts-native: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=1000 on wasmoon: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=1000 on go-native: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=1000 on gopher-lua: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=1000 on starlark-go: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=1000 on cpython: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=1000 on applescript: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10000 on quickjs: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10000 on ts-native: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10000 on wasmoon: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10000 on go-native: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10000 on gopher-lua: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10000 on starlark-go: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10000 on cpython: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10000 on applescript: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- text/graphemes on quickjs: Unicode grapheme segmentation has no shared API across the pinned peers; text/iterate and text/index compare ASCII.
- text/graphemes on ts-native: Unicode grapheme segmentation has no shared API across the pinned peers; text/iterate and text/index compare ASCII.
- text/graphemes on wasmoon: Unicode grapheme segmentation has no shared API across the pinned peers; text/iterate and text/index compare ASCII.
- text/graphemes on go-native: Unicode grapheme segmentation has no shared API across the pinned peers; text/iterate and text/index compare ASCII.
- text/graphemes on gopher-lua: Unicode grapheme segmentation has no shared API across the pinned peers; text/iterate and text/index compare ASCII.
- text/graphemes on starlark-go: Unicode grapheme segmentation has no shared API across the pinned peers; text/iterate and text/index compare ASCII.
- text/graphemes on cpython: Unicode grapheme segmentation has no shared API across the pinned peers; text/iterate and text/index compare ASCII.
- text/graphemes on applescript: Unicode grapheme segmentation has no shared API across the pinned peers; text/iterate and text/index compare ASCII.
- host/immediate on zig: The native benchmark Host does not yet install immediate bindings; this is a runner limitation, not a Core limitation.
- host/immediate on quickjs: NorthTalk embedding API; no peer counterpart.
- host/immediate on ts-native: NorthTalk embedding API; no peer counterpart.
- host/immediate on wasmoon: NorthTalk embedding API; no peer counterpart.
- host/immediate on go-native: NorthTalk embedding API; no peer counterpart.
- host/immediate on gopher-lua: NorthTalk embedding API; no peer counterpart.
- host/immediate on starlark-go: NorthTalk embedding API; no peer counterpart.
- host/immediate on cpython: NorthTalk embedding API; no peer counterpart.
- host/immediate on applescript: NorthTalk embedding API; no peer counterpart.
- host/suspending on zig: The native benchmark Host does not yet install suspending bindings; this is a runner limitation, not a Core limitation.
- host/suspending on quickjs: NorthTalk embedding API; no peer counterpart.
- host/suspending on ts-native: NorthTalk embedding API; no peer counterpart.
- host/suspending on wasmoon: NorthTalk embedding API; no peer counterpart.
- host/suspending on go-native: NorthTalk embedding API; no peer counterpart.
- host/suspending on gopher-lua: NorthTalk embedding API; no peer counterpart.
- host/suspending on starlark-go: NorthTalk embedding API; no peer counterpart.
- host/suspending on cpython: NorthTalk embedding API; no peer counterpart.
- host/suspending on applescript: NorthTalk embedding API; no peer counterpart.
- host/properties on zig: The native benchmark Host does not yet install properties bindings; this is a runner limitation, not a Core limitation.
- host/properties on quickjs: NorthTalk embedding API; no peer counterpart.
- host/properties on ts-native: NorthTalk embedding API; no peer counterpart.
- host/properties on wasmoon: NorthTalk embedding API; no peer counterpart.
- host/properties on go-native: NorthTalk embedding API; no peer counterpart.
- host/properties on gopher-lua: NorthTalk embedding API; no peer counterpart.
- host/properties on starlark-go: NorthTalk embedding API; no peer counterpart.
- host/properties on cpython: NorthTalk embedding API; no peer counterpart.
- host/properties on applescript: NorthTalk embedding API; no peer counterpart.
- host/conversion on zig: The native benchmark Host does not yet install conversion bindings; this is a runner limitation, not a Core limitation.
- host/conversion on quickjs: NorthTalk embedding API; no peer counterpart.
- host/conversion on ts-native: NorthTalk embedding API; no peer counterpart.
- host/conversion on wasmoon: NorthTalk embedding API; no peer counterpart.
- host/conversion on go-native: NorthTalk embedding API; no peer counterpart.
- host/conversion on gopher-lua: NorthTalk embedding API; no peer counterpart.
- host/conversion on starlark-go: NorthTalk embedding API; no peer counterpart.
- host/conversion on cpython: NorthTalk embedding API; no peer counterpart.
- host/conversion on applescript: NorthTalk embedding API; no peer counterpart.
- host/pump on quickjs: NorthTalk embedding API; no peer counterpart.
- host/pump on ts-native: NorthTalk embedding API; no peer counterpart.
- host/pump on wasmoon: NorthTalk embedding API; no peer counterpart.
- host/pump on go-native: NorthTalk embedding API; no peer counterpart.
- host/pump on gopher-lua: NorthTalk embedding API; no peer counterpart.
- host/pump on starlark-go: NorthTalk embedding API; no peer counterpart.
- host/pump on cpython: NorthTalk embedding API; no peer counterpart.
- host/pump on applescript: NorthTalk embedding API; no peer counterpart.
- messaging/sends on zig: The native benchmark Host does not yet install partner bindings; this is a runner limitation, not a Core limitation.
- messaging/sends on quickjs: NorthTalk embedding API; no peer counterpart.
- messaging/sends on ts-native: NorthTalk embedding API; no peer counterpart.
- messaging/sends on wasmoon: NorthTalk embedding API; no peer counterpart.
- messaging/sends on go-native: NorthTalk embedding API; no peer counterpart.
- messaging/sends on gopher-lua: NorthTalk embedding API; no peer counterpart.
- messaging/sends on starlark-go: NorthTalk embedding API; no peer counterpart.
- messaging/sends on cpython: NorthTalk embedding API; no peer counterpart.
- messaging/sends on applescript: NorthTalk embedding API; no peer counterpart.
- messaging/parents on zig: The native benchmark Host does not yet install parents bindings; this is a runner limitation, not a Core limitation.
- messaging/parents on quickjs: NorthTalk embedding API; no peer counterpart.
- messaging/parents on ts-native: NorthTalk embedding API; no peer counterpart.
- messaging/parents on wasmoon: NorthTalk embedding API; no peer counterpart.
- messaging/parents on go-native: NorthTalk embedding API; no peer counterpart.
- messaging/parents on gopher-lua: NorthTalk embedding API; no peer counterpart.
- messaging/parents on starlark-go: NorthTalk embedding API; no peer counterpart.
- messaging/parents on cpython: NorthTalk embedding API; no peer counterpart.
- messaging/parents on applescript: NorthTalk embedding API; no peer counterpart.
- messaging/joins on zig: The native benchmark Host does not yet install partner bindings; this is a runner limitation, not a Core limitation.
- messaging/joins on quickjs: NorthTalk embedding API; no peer counterpart.
- messaging/joins on ts-native: NorthTalk embedding API; no peer counterpart.
- messaging/joins on wasmoon: NorthTalk embedding API; no peer counterpart.
- messaging/joins on go-native: NorthTalk embedding API; no peer counterpart.
- messaging/joins on gopher-lua: NorthTalk embedding API; no peer counterpart.
- messaging/joins on starlark-go: NorthTalk embedding API; no peer counterpart.
- messaging/joins on cpython: NorthTalk embedding API; no peer counterpart.
- messaging/joins on applescript: NorthTalk embedding API; no peer counterpart.
- messaging/suspend on quickjs: NorthTalk embedding API; no peer counterpart.
- messaging/suspend on ts-native: NorthTalk embedding API; no peer counterpart.
- messaging/suspend on wasmoon: NorthTalk embedding API; no peer counterpart.
- messaging/suspend on go-native: NorthTalk embedding API; no peer counterpart.
- messaging/suspend on gopher-lua: NorthTalk embedding API; no peer counterpart.
- messaging/suspend on starlark-go: NorthTalk embedding API; no peer counterpart.
- messaging/suspend on cpython: NorthTalk embedding API; no peer counterpart.
- messaging/suspend on applescript: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-small on quickjs: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-small on ts-native: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-small on wasmoon: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-small on go-native: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-small on gopher-lua: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-small on starlark-go: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-small on cpython: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-small on applescript: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-large on quickjs: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-large on ts-native: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-large on wasmoon: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-large on go-native: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-large on gopher-lua: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-large on starlark-go: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-large on cpython: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-large on applescript: NorthTalk embedding API; no peer counterpart.
- lifecycle/restore on zig: The native benchmark Host does not yet install restore bindings; this is a runner limitation, not a Core limitation.
- lifecycle/restore on quickjs: NorthTalk embedding API; no peer counterpart.
- lifecycle/restore on ts-native: NorthTalk embedding API; no peer counterpart.
- lifecycle/restore on wasmoon: NorthTalk embedding API; no peer counterpart.
- lifecycle/restore on go-native: NorthTalk embedding API; no peer counterpart.
- lifecycle/restore on gopher-lua: NorthTalk embedding API; no peer counterpart.
- lifecycle/restore on starlark-go: NorthTalk embedding API; no peer counterpart.
- lifecycle/restore on cpython: NorthTalk embedding API; no peer counterpart.
- lifecycle/restore on applescript: NorthTalk embedding API; no peer counterpart.
- lifecycle/rollback on zig: The native benchmark Host does not yet install suspending bindings; this is a runner limitation, not a Core limitation.
- lifecycle/rollback on quickjs: NorthTalk embedding API; no peer counterpart.
- lifecycle/rollback on ts-native: NorthTalk embedding API; no peer counterpart.
- lifecycle/rollback on wasmoon: NorthTalk embedding API; no peer counterpart.
- lifecycle/rollback on go-native: NorthTalk embedding API; no peer counterpart.
- lifecycle/rollback on gopher-lua: NorthTalk embedding API; no peer counterpart.
- lifecycle/rollback on starlark-go: NorthTalk embedding API; no peer counterpart.
- lifecycle/rollback on cpython: NorthTalk embedding API; no peer counterpart.
- lifecycle/rollback on applescript: NorthTalk embedding API; no peer counterpart.
