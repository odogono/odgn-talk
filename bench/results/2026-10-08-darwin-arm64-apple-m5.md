# Benchmark results, 2026-10-08

Commit `76f36e2` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.2, cost model 0, go go1.27.1, language 1.0-rc.2, cpython 3.14.8, gopher-lua v1.1.2, quickjs-emscripten 0.32.0, starlark-go v0.0.0-20261005163335-bcb1a1a55bf9, wasmoon 1.16.0.
Settings: count 10, runners go,ts,peers, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | go | 90.4 | 16.211 | 16.125 | 89459 | 181.2 | 195.6 KiB | 9.7 MiB | 133765 |
| collections/iterate | ts | 417.3 | 28.316 | 24.148 | 89459 | 316.5 | 195.6 KiB | 99.1 KiB |  |
| collections/iterate | cpython |  | 0.0539 | 0.0535 |  |  |  | 2.5 KiB |  |
| collections/iterate | go-native |  | 0.0184 | 0.0181 |  |  |  | 1.8 KiB | 4 |
| collections/iterate | gopher-lua |  | 0.396 | 0.394 |  |  |  | 108.8 KiB | 6741 |
| collections/iterate | quickjs |  | 0.134 | 0.124 |  |  |  |  |  |
| collections/iterate | starlark-go |  | 0.173 | 0.172 |  |  |  | 270.5 KiB | 783 |
| collections/iterate | ts-native |  | 0.00751 | 0.00737 |  |  |  | 1 B |  |
| collections/iterate | wasmoon |  | 0.122 | 0.116 |  |  |  |  |  |
| collections/list-build | go | 47.5 | 11.361 | 11.300 | 19091 | 595.1 | 2.9 MiB | 77.7 MiB | 20583 |
| collections/list-build | ts | 189.6 | 16.498 | 16.029 | 19091 | 864.2 | 2.9 MiB | 3.4 MiB |  |
| collections/list-build | cpython |  | 0.00758 | 0.00753 |  |  |  | 8.6 KiB |  |
| collections/list-build | go-native |  | 0.000747 | 0.000710 |  |  |  | 4.0 KiB | 2 |
| collections/list-build | gopher-lua |  | 0.0376 | 0.0374 |  |  |  | 35.4 KiB | 1045 |
| collections/list-build | quickjs |  | 0.0273 | 0.0232 |  |  |  |  |  |
| collections/list-build | starlark-go |  | 0.0175 | 0.0174 |  |  |  | 18.7 KiB | 18 |
| collections/list-build | ts-native |  | 0.000805 | 0.000781 |  |  |  | 1 B |  |
| collections/list-build | wasmoon |  | 0.0110 | 0.0100 |  |  |  |  |  |
| collections/list-update | go | 67.4 | 6.548 | 6.534 | 28553 | 229.3 | 23.8 KiB | 14.3 MiB | 76608 |
| collections/list-update | ts | 363.1 | 4.623 | 4.222 | 28553 | 161.9 | 23.8 KiB | 36.1 KiB |  |
| collections/list-update | cpython |  | 0.00927 | 0.00919 |  |  |  | 184 B |  |
| collections/list-update | go-native |  | 0.000424 | 0.000407 |  |  |  | 72 B | 2 |
| collections/list-update | gopher-lua |  | 0.0260 | 0.0257 |  |  |  | 22.4 KiB | 106 |
| collections/list-update | quickjs |  | 0.0184 | 0.0177 |  |  |  |  |  |
| collections/list-update | starlark-go |  | 0.0312 | 0.0306 |  |  |  | 704 B | 13 |
| collections/list-update | ts-native |  | 0.000731 | 0.000724 |  |  |  | 0 B |  |
| collections/list-update | wasmoon |  | 0.00570 | 0.00556 |  |  |  |  |  |
| collections/map-build | go | 60.9 | 6.940 | 6.914 | 14094 | 492.4 | 24.3 KiB | 34.9 MiB | 20497 |
| collections/map-build | ts | 250.8 | 18.293 | 17.570 | 14094 | 1297.9 | 24.3 KiB | 3.8 MiB |  |
| collections/map-build | cpython |  | 0.0145 | 0.0143 |  |  |  | 19.3 KiB |  |
| collections/map-build | go-native |  | 0.00647 | 0.00607 |  |  |  | 13.9 KiB | 205 |
| collections/map-build | gopher-lua |  | 0.0790 | 0.0785 |  |  |  | 90.5 KiB | 1291 |
| collections/map-build | quickjs |  | 0.0310 | 0.0307 |  |  |  |  |  |
| collections/map-build | starlark-go |  | 0.0371 | 0.0370 |  |  |  | 99.4 KiB | 827 |
| collections/map-build | ts-native |  | 0.00353 | 0.00344 |  |  |  | 71 B |  |
| collections/map-build | wasmoon |  | 0.0415 | 0.0399 |  |  |  |  |  |
| collections/map-update | go | 79.6 | 1.615 | 1.612 | 8056 | 200.5 | 12.1 KiB | 3.0 MiB | 11071 |
| collections/map-update | ts | 374.4 | 2.469 | 2.286 | 8056 | 306.5 | 12.1 KiB | 1.3 KiB |  |
| collections/map-update | cpython |  | 0.00410 | 0.00409 |  |  |  | 480 B |  |
| collections/map-update | go-native |  | 0.00314 | 0.00301 |  |  |  | 520 B | 5 |
| collections/map-update | gopher-lua |  | 0.0191 | 0.0189 |  |  |  | 10.2 KiB | 76 |
| collections/map-update | quickjs |  | 0.0196 | 0.0189 |  |  |  |  |  |
| collections/map-update | starlark-go |  | 0.0135 | 0.0132 |  |  |  | 1.7 KiB | 11 |
| collections/map-update | ts-native |  | 0.00141 | 0.00139 |  |  |  | 0 B |  |
| collections/map-update | wasmoon |  | 0.00342 | 0.00334 |  |  |  |  |  |
| core/calls | go | 52.6 | 5.356 | 5.344 | 46018 | 116.4 | 31.3 KiB | 4.1 MiB | 54019 |
| core/calls | ts | 211.5 | 9.620 | 8.925 | 46018 | 209.0 | 31.3 KiB | 168.7 KiB |  |
| core/calls | cpython |  | 0.0307 | 0.0307 |  |  |  | 0 B |  |
| core/calls | go-native |  | 0.000488 | 0.000487 |  |  |  | 8 B | 1 |
| core/calls | gopher-lua |  | 0.0725 | 0.0721 |  |  |  | 44.8 KiB | 180 |
| core/calls | quickjs |  | 0.0467 | 0.0466 |  |  |  |  |  |
| core/calls | starlark-go |  | 0.111 | 0.110 |  |  |  | 125.3 KiB | 2006 |
| core/calls | ts-native |  | 0.000563 | 0.000526 |  |  |  | 0 B |  |
| core/calls | wasmoon |  | 0.0230 | 0.0226 |  |  |  |  |  |
| core/fib | go | 51.3 | 5.212 | 5.205 | 46365 | 112.4 | 46.2 KiB | 3.4 MiB | 62250 |
| core/fib | ts | 213.8 | 9.696 | 9.089 | 46365 | 209.1 | 46.2 KiB | 440.2 KiB |  |
| core/fib | cpython |  | 0.0248 | 0.0248 |  |  |  | 0 B |  |
| core/fib | go-native |  | 0.00130 | 0.00129 |  |  |  | 8 B | 1 |
| core/fib | gopher-lua |  | 0.0710 | 0.0696 |  |  |  | 64 B | 1 |
| core/fib | quickjs |  | 0.0415 | 0.0413 |  |  |  |  |  |
| core/fib | starlark-go |  | 0.140 | 0.139 |  |  |  | 154.2 KiB | 1975 |
| core/fib | ts-native |  | 0.00188 | 0.00187 |  |  |  | 0 B |  |
| core/fib | wasmoon |  | 0.0265 | 0.0263 |  |  |  |  |  |
| core/fib@slice=10 | go | 51.7 | 10.179 | 10.148 | 46365 | 219.5 | 46.2 KiB | 18.3 MiB | 189362 |
| core/fib@slice=10 | ts | 164.8 | 19.560 | 18.403 | 46365 | 421.9 | 46.2 KiB | 948.0 KiB |  |
| core/fib@slice=100 | go | 51.3 | 6.090 | 6.073 | 46365 | 131.4 | 46.2 KiB | 6.9 MiB | 79185 |
| core/fib@slice=100 | ts | 153.4 | 10.929 | 10.387 | 46365 | 235.7 | 46.2 KiB | 0 B |  |
| core/fib@slice=1000 | go | 51.5 | 5.332 | 5.325 | 46365 | 115.0 | 46.2 KiB | 4.0 MiB | 64316 |
| core/fib@slice=1000 | ts | 152.3 | 9.907 | 9.541 | 46365 | 213.7 | 46.2 KiB | 0 B |  |
| core/fib@slice=10000 | go | 51.6 | 5.214 | 5.198 | 46365 | 112.4 | 46.2 KiB | 3.5 MiB | 62445 |
| core/fib@slice=10000 | ts | 151.3 | 9.631 | 9.197 | 46365 | 207.7 | 46.2 KiB | 7.0 KiB |  |
| core/lambdas | go | 58.6 | 7.701 | 7.692 | 58027 | 132.7 | 62.6 KiB | 6.4 MiB | 84012 |
| core/lambdas | ts | 287.1 | 17.259 | 16.546 | 58027 | 297.4 | 62.6 KiB | 882.0 KiB |  |
| core/lambdas | cpython |  | 0.0401 | 0.0399 |  |  |  | 208 B |  |
| core/lambdas | go-native |  | 0.000501 | 0.000498 |  |  |  | 8 B | 1 |
| core/lambdas | gopher-lua |  | 0.0871 | 0.0859 |  |  |  | 60.3 KiB | 244 |
| core/lambdas | quickjs |  | 0.0509 | 0.0506 |  |  |  |  |  |
| core/lambdas | starlark-go |  | 0.136 | 0.135 |  |  |  | 156.6 KiB | 2010 |
| core/lambdas | ts-native |  | 0.000961 | 0.000939 |  |  |  | 5 B |  |
| core/lambdas | wasmoon |  | 0.0289 | 0.0268 |  |  |  |  |  |
| core/loop | go | 43.6 | 7.471 | 7.453 | 48016 | 155.6 | 62.5 KiB | 1.9 MiB | 79973 |
| core/loop | ts | 166.2 | 14.780 | 13.920 | 48016 | 307.8 | 62.5 KiB | 661.6 KiB |  |
| core/loop | cpython |  | 0.0184 | 0.0184 |  |  |  | 0 B |  |
| core/loop | go-native |  | 0.000501 | 0.000500 |  |  |  | 8 B | 1 |
| core/loop | gopher-lua |  | 0.0264 | 0.0260 |  |  |  | 44.8 KiB | 180 |
| core/loop | quickjs |  | 0.0181 | 0.0173 |  |  |  |  |  |
| core/loop | starlark-go |  | 0.0390 | 0.0388 |  |  |  | 256 B | 6 |
| core/loop | ts-native |  | 0.000548 | 0.000521 |  |  |  | 1 B |  |
| core/loop | wasmoon |  | 0.00707 | 0.00702 |  |  |  |  |  |
| host/conversion | go | 60.7 | 9.192 | 8.326 | 25018 | 367.4 | 220.3 KiB | 13.1 MiB | 117146 |
| host/conversion | ts | 315.9 | 10.331 | 9.841 | 25018 | 412.9 | 220.3 KiB | 155.4 KiB |  |
| host/immediate | go | 45.8 | 2.000 | 1.989 | 13518 | 148.0 | 15.7 KiB | 1.5 MiB | 28241 |
| host/immediate | ts | 209.1 | 3.645 | 3.275 | 13518 | 269.6 | 15.7 KiB | 347 B |  |
| host/properties | go | 42.7 | 2.018 | 1.824 | 9018 | 223.8 | 15.7 KiB | 918.2 KiB | 18421 |
| host/properties | ts | 172.9 | 3.394 | 3.101 | 9018 | 376.4 | 15.7 KiB | 211.6 KiB |  |
| host/pump | go | 13.5 | 0.00542 | 0.00496 | 7 | 773.9 | 0 B | 12.5 KiB | 69 |
| host/pump | ts | 30.7 | 0.00632 | 0.00573 | 7 | 902.6 | 0 B | 2.1 KiB |  |
| host/suspending | go | 45.5 | 4.895 | 3.893 | 13518 | 362.1 | 15.7 KiB | 6.1 MiB | 71478 |
| host/suspending | ts | 199.0 | 6.328 | 5.589 | 13518 | 468.1 | 15.7 KiB | 139.2 KiB |  |
| lifecycle/load-large | go | 4355.5 | 0.758 | 0.756 | 4609 | 164.5 | 16.3 KiB | 470.4 KiB | 7313 |
| lifecycle/load-large | ts | 24787.5 | 1.226 | 1.152 | 4609 | 265.9 | 16.3 KiB | 23.3 KiB |  |
| lifecycle/load-small | go | 17.9 | 0.00415 | 0.00411 | 7 | 592.5 | 0 B | 12.6 KiB | 72 |
| lifecycle/load-small | ts | 48.4 | 0.00696 | 0.00554 | 7 | 994.7 | 0 B | 2.2 KiB |  |
| lifecycle/restore | go | 87.2 | 50.648 | 50.579 | 8015 | 6319.2 | 7.8 KiB | 66.4 MiB | 575675 |
| lifecycle/restore | ts | 414.7 | 11.663 | 11.275 | 8015 | 1455.1 | 7.8 KiB | 183.6 KiB |  |
| lifecycle/rollback | go | 87.1 | 41.991 | 41.392 | 27049 | 1552.4 | 39.2 KiB | 330.9 MiB | 57980 |
| lifecycle/rollback | ts | 387.8 | 59.898 | 59.073 | 27049 | 2214.4 | 39.2 KiB | 13.3 MiB |  |
| macro/game-tick | go | 86.7 | 9.313 | 9.191 | 67042 | 138.9 | 78.4 KiB | 7.9 MiB | 81910 |
| macro/game-tick | ts | 362.7 | 15.388 | 14.541 | 67042 | 229.5 | 78.4 KiB | 1.8 KiB |  |
| macro/game-tick | cpython |  | 0.0517 | 0.0515 |  |  |  | 0 B |  |
| macro/game-tick | go-native |  | 0.000251 | 0.000250 |  |  |  | 8 B | 1 |
| macro/game-tick | gopher-lua |  | 0.128 | 0.127 |  |  |  | 28.7 KiB | 128 |
| macro/game-tick | quickjs |  | 0.0412 | 0.0403 |  |  |  |  |  |
| macro/game-tick | starlark-go |  | 0.150 | 0.149 |  |  |  | 94.5 KiB | 1007 |
| macro/game-tick | ts-native |  | 0.000330 | 0.000324 |  |  |  | 0 B |  |
| macro/game-tick | wasmoon |  | 0.0253 | 0.0236 |  |  |  |  |  |
| macro/report | go | 55.3 | 1.980 | 1.961 | 86555 | 22.9 | 1.2 MiB | 1.8 MiB | 16384 |
| macro/report | ts | 198.2 | 15.062 | 14.498 | 86555 | 174.0 | 1.2 MiB | 3.3 MiB |  |
| macro/report | cpython |  | 0.0196 | 0.0195 |  |  |  | 14.8 KiB |  |
| macro/report | go-native |  | 0.0102 | 0.00962 |  |  |  | 8.8 KiB | 85 |
| macro/report | gopher-lua |  | 0.127 | 0.125 |  |  |  | 33.0 KiB | 1290 |
| macro/report | quickjs |  | 0.0394 | 0.0389 |  |  |  |  |  |
| macro/report | starlark-go |  | 0.0575 | 0.0572 |  |  |  | 66.2 KiB | 3084 |
| macro/report | ts-native |  | 0.00288 | 0.00277 |  |  |  | 6 B |  |
| macro/report | wasmoon |  | 0.0404 | 0.0346 |  |  |  |  |  |
| macro/transform | go | 74.6 | 21.096 | 20.950 | 20664 | 1020.9 | 6.1 MiB | 64.0 MiB | 207984 |
| macro/transform | ts | 287.8 | 14.666 | 14.327 | 20664 | 709.7 | 6.1 MiB | 1.7 MiB |  |
| macro/transform | cpython |  | 0.0185 | 0.0184 |  |  |  | 48.0 KiB |  |
| macro/transform | go-native |  | 0.000776 | 0.000768 |  |  |  | 7.4 KiB | 3 |
| macro/transform | gopher-lua |  | 0.120 | 0.119 |  |  |  | 268.0 KiB | 4538 |
| macro/transform | quickjs |  | 0.0529 | 0.0526 |  |  |  |  |  |
| macro/transform | starlark-go |  | 0.0522 | 0.0520 |  |  |  | 168.7 KiB | 328 |
| macro/transform | ts-native |  | 0.00248 | 0.00243 |  |  |  | 1 B |  |
| macro/transform | wasmoon |  | 0.0317 | 0.0248 |  |  |  |  |  |
| messaging/joins | go | 81.6 | 24.700 | 24.610 | 127218 | 194.2 | 239.1 KiB | 48.7 MiB | 344032 |
| messaging/joins | ts | 334.5 | 33.048 | 31.479 | 127218 | 259.8 | 239.1 KiB | 1.6 MiB |  |
| messaging/parents | go | 53.0 | 16.678 | 16.635 | 67518 | 247.0 | 93.8 KiB | 30.5 MiB | 277292 |
| messaging/parents | ts | 229.5 | 23.520 | 22.324 | 67518 | 348.3 | 93.8 KiB | 4.8 KiB |  |
| messaging/sends | go | 62.2 | 15.457 | 14.860 | 67518 | 228.9 | 93.8 KiB | 32.2 MiB | 238292 |
| messaging/sends | ts | 259.5 | 22.619 | 18.518 | 67518 | 335.0 | 93.8 KiB | 232.8 KiB |  |
| messaging/suspend | go | 41.8 | 15.295 | 15.238 | 48018 | 318.5 | 31.3 KiB | 20.2 MiB | 384047 |
| messaging/suspend | ts | 158.3 | 23.887 | 22.820 | 48018 | 497.5 | 31.3 KiB | 428.1 KiB |  |
| numbers/add | go | 45.5 | 4.285 | 4.263 | 26030 | 164.6 | 31.4 KiB | 1.8 MiB | 46096 |
| numbers/add | ts | 196.8 | 10.369 | 9.839 | 26030 | 398.4 | 31.4 KiB | 633.7 KiB |  |
| numbers/add | cpython |  | 0.0198 | 0.0193 |  |  |  | 0 B |  |
| numbers/add | go-native |  | 0.00116 | 0.00116 |  |  |  | 8 B | 1 |
| numbers/add | gopher-lua |  | 0.0263 | 0.0261 |  |  |  | 43.9 KiB | 177 |
| numbers/add | quickjs |  | 0.0187 | 0.0186 |  |  |  |  |  |
| numbers/add | starlark-go |  | 0.0448 | 0.0445 |  |  |  | 15.9 KiB | 2010 |
| numbers/add | ts-native |  | 0.000997 | 0.000979 |  |  |  | 0 B |  |
| numbers/add | wasmoon |  | 0.00704 | 0.00693 |  |  |  |  |  |
| numbers/divide | go | 47.1 | 4.530 | 4.523 | 18031 | 251.2 | 31.4 KiB | 4.0 MiB | 145726 |
| numbers/divide | ts | 178.9 | 8.658 | 8.216 | 18031 | 480.2 | 31.4 KiB | 558.2 KiB |  |
| numbers/divide | cpython |  | 0.0156 | 0.0156 |  |  |  | 0 B |  |
| numbers/divide | go-native |  | 0.000757 | 0.000753 |  |  |  | 8 B | 1 |
| numbers/divide | gopher-lua |  | 0.0195 | 0.0194 |  |  |  | 28.3 KiB | 115 |
| numbers/divide | quickjs |  | 0.0144 | 0.0143 |  |  |  |  |  |
| numbers/divide | starlark-go |  | 0.0382 | 0.0380 |  |  |  | 15.9 KiB | 2010 |
| numbers/divide | ts-native |  | 0.000551 | 0.000519 |  |  |  | 0 B |  |
| numbers/divide | wasmoon |  | 0.00572 | 0.00556 |  |  |  |  |  |
| numbers/multiply | go | 47.4 | 2.957 | 2.952 | 18031 | 164.0 | 31.4 KiB | 1.2 MiB | 37088 |
| numbers/multiply | ts | 181.1 | 8.694 | 8.300 | 18031 | 482.1 | 31.4 KiB | 848.6 KiB |  |
| numbers/multiply | cpython |  | 0.0155 | 0.0154 |  |  |  | 0 B |  |
| numbers/multiply | go-native |  | 0.000753 | 0.000751 |  |  |  | 8 B | 1 |
| numbers/multiply | gopher-lua |  | 0.0181 | 0.0180 |  |  |  | 29.1 KiB | 118 |
| numbers/multiply | quickjs |  | 0.0191 | 0.0190 |  |  |  |  |  |
| numbers/multiply | starlark-go |  | 0.0366 | 0.0364 |  |  |  | 15.9 KiB | 2010 |
| numbers/multiply | ts-native |  | 0.000550 | 0.000521 |  |  |  | 0 B |  |
| numbers/multiply | wasmoon |  | 0.00614 | 0.00602 |  |  |  |  |  |
| numbers/quantity | go | 57.6 | 5.847 | 5.827 | 14579 | 401.0 | 39.1 KiB | 5.4 MiB | 214416 |
| numbers/quantity | ts | 227.1 | 15.288 | 14.540 | 14579 | 1048.6 | 39.1 KiB | 693.6 KiB |  |
| numbers/quantity | cpython |  | 0.00980 | 0.00976 |  |  |  | 0 B |  |
| numbers/quantity | go-native |  | 0.000259 | 0.000258 |  |  |  | 8 B | 1 |
| numbers/quantity | gopher-lua |  | 0.0113 | 0.0112 |  |  |  | 16.5 KiB | 67 |
| numbers/quantity | quickjs |  | 0.00639 | 0.00633 |  |  |  |  |  |
| numbers/quantity | starlark-go |  | 0.0249 | 0.0246 |  |  |  | 8.1 KiB | 1009 |
| numbers/quantity | ts-native |  | 0.000316 | 0.000313 |  |  |  | 0 B |  |
| numbers/quantity | wasmoon |  | 0.00442 | 0.00431 |  |  |  |  |  |
| text/build | go | 42.0 | 1.063 | 1.061 | 28928 | 36.7 | 374.8 KiB | 853.4 KiB | 9048 |
| text/build | ts | 163.4 | 4.845 | 4.565 | 28928 | 167.5 | 374.8 KiB | 384.8 KiB |  |
| text/build | cpython |  | 0.0102 | 0.0102 |  |  |  | 1.5 KiB |  |
| text/build | go-native |  | 0.0547 | 0.0371 |  |  |  | 387.1 KiB | 500 |
| text/build | gopher-lua |  | 0.0541 | 0.0538 |  |  |  | 400.8 KiB | 1024 |
| text/build | quickjs |  | 0.0203 | 0.0201 |  |  |  |  |  |
| text/build | starlark-go |  | 0.0510 | 0.0501 |  |  |  | 395.1 KiB | 1006 |
| text/build | ts-native |  | 0.00119 | 0.00116 |  |  |  | 1 B |  |
| text/build | wasmoon |  | 0.0401 | 0.0384 |  |  |  |  |  |
| text/graphemes | go | 51.5 | 7.417 | 7.389 | 43518 | 170.4 | 144.1 KiB | 4.9 MiB | 83423 |
| text/graphemes | ts | 193.5 | 13.805 | 12.780 | 43518 | 317.2 | 144.1 KiB | 897.6 KiB |  |
| text/index | go | 53.0 | 6.736 | 6.722 | 26640 | 252.9 | 49.9 KiB | 6.2 MiB | 195185 |
| text/index | ts | 220.5 | 14.880 | 13.955 | 26640 | 558.5 | 49.9 KiB | 370.7 KiB |  |
| text/index | cpython |  | 0.0166 | 0.0165 |  |  |  | 0 B |  |
| text/index | go-native |  | 0.000416 | 0.000403 |  |  |  | 0 B | 0 |
| text/index | gopher-lua |  | 0.112 | 0.112 |  |  |  | 29.3 KiB | 1055 |
| text/index | quickjs |  | 0.0393 | 0.0385 |  |  |  |  |  |
| text/index | starlark-go |  | 0.0484 | 0.0476 |  |  |  | 15.9 KiB | 1006 |
| text/index | ts-native |  | 0.000719 | 0.000634 |  |  |  | 0 B |  |
| text/index | wasmoon |  | 0.0315 | 0.0294 |  |  |  |  |  |
| text/iterate | go | 48.7 | 4.908 | 4.836 | 30318 | 161.9 | 93.0 KiB | 3.5 MiB | 54622 |
| text/iterate | ts | 186.4 | 9.542 | 8.874 | 30318 | 314.7 | 93.0 KiB | 976.9 KiB |  |
| text/iterate | cpython |  | 0.0186 | 0.0185 |  |  |  | 48 B |  |
| text/iterate | go-native |  | 0.000530 | 0.000496 |  |  |  | 8 B | 1 |
| text/iterate | gopher-lua |  | 0.166 | 0.165 |  |  |  | 187.3 KiB | 9847 |
| text/iterate | quickjs |  | 0.0544 | 0.0516 |  |  |  |  |  |
| text/iterate | starlark-go |  | 0.107 | 0.107 |  |  |  | 62.0 KiB | 3607 |
| text/iterate | ts-native |  | 0.00106 | 0.00105 |  |  |  | 0 B |  |
| text/iterate | wasmoon |  | 0.0426 | 0.0397 |  |  |  |  |  |
| text/patterns | go | 50.1 | 4.206 | 4.191 | 13818 | 304.4 | 225.9 KiB | 7.7 MiB | 66597 |
| text/patterns | ts | 204.1 | 6.552 | 6.163 | 13818 | 474.2 | 225.9 KiB | 364.5 KiB |  |
| text/patterns | cpython |  | 0.0478 | 0.0474 |  |  |  | 1.2 KiB |  |
| text/patterns | go-native |  | 0.0660 | 0.0601 |  |  |  | 37.7 KiB | 1201 |
| text/patterns | gopher-lua |  | 0.249 | 0.247 |  |  |  | 390.8 KiB | 17736 |
| text/patterns | quickjs |  | 0.208 | 0.200 |  |  |  |  |  |
| text/patterns | starlark-go |  | 0.182 | 0.181 |  |  |  | 87.0 KiB | 4507 |
| text/patterns | ts-native |  | 0.0137 | 0.0137 |  |  |  | 15 B |  |
| text/patterns | wasmoon |  | 0.0601 | 0.0575 |  |  |  |  |  |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- numbers/quantity on ts: 1048.6 ns/Fuel, 3.1× the median
- collections/map-build on ts: 1297.9 ns/Fuel, 3.9× the median
- lifecycle/rollback on ts: 2214.4 ns/Fuel, 6.6× the median
- host/pump on go: 773.9 ns/Fuel, 3.9× the median
- macro/transform on go: 1020.9 ns/Fuel, 5.1× the median
- lifecycle/rollback on go: 1552.4 ns/Fuel, 7.7× the median

## Skipped

- core/fib@slice=10 on peers: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=100 on peers: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=1000 on peers: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- core/fib@slice=10000 on peers: A Fuel Slice is a NorthTalk Pump option; no peer counterpart.
- text/graphemes on peers: Unicode grapheme segmentation has no shared API across the pinned peers; text/iterate and text/index compare ASCII.
- host/immediate on peers: NorthTalk embedding API; no peer counterpart.
- host/suspending on peers: NorthTalk embedding API; no peer counterpart.
- host/properties on peers: NorthTalk embedding API; no peer counterpart.
- host/conversion on peers: NorthTalk embedding API; no peer counterpart.
- host/pump on peers: NorthTalk embedding API; no peer counterpart.
- messaging/sends on peers: NorthTalk embedding API; no peer counterpart.
- messaging/parents on peers: NorthTalk embedding API; no peer counterpart.
- messaging/joins on peers: NorthTalk embedding API; no peer counterpart.
- messaging/suspend on peers: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-small on peers: NorthTalk embedding API; no peer counterpart.
- lifecycle/load-large on peers: NorthTalk embedding API; no peer counterpart.
- lifecycle/restore on peers: NorthTalk embedding API; no peer counterpart.
- lifecycle/rollback on peers: NorthTalk embedding API; no peer counterpart.
