# Benchmark results, 2026-10-08

Commit `d66c6e1` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.2, cost model 0, go go1.27.1, language 1.0-rc.2, cpython 3.14.8, gopher-lua v1.1.2, quickjs-emscripten 0.32.0, starlark-go v0.0.0-20261005163335-bcb1a1a55bf9, wasmoon 1.16.0.
Settings: count 10, runners go,ts,peers, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | go | 88.4 | 16.249 | 16.205 | 89459 | 181.6 | 195.6 KiB | 9.7 MiB | 133765 |
| collections/iterate | ts | 406.5 | 28.491 | 24.384 | 89459 | 318.5 | 195.6 KiB | 318.8 KiB |  |
| collections/iterate | cpython |  | 0.0541 | 0.0539 |  |  |  | 2.5 KiB |  |
| collections/iterate | go-native |  | 0.0169 | 0.0169 |  |  |  | 1.8 KiB | 4 |
| collections/iterate | gopher-lua |  | 0.393 | 0.390 |  |  |  | 108.8 KiB | 6741 |
| collections/iterate | quickjs |  | 0.132 | 0.127 |  |  |  |  |  |
| collections/iterate | starlark-go |  | 0.175 | 0.174 |  |  |  | 270.5 KiB | 783 |
| collections/iterate | ts-native |  | 0.00753 | 0.00747 |  |  |  | 2 B |  |
| collections/iterate | wasmoon |  | 0.116 | 0.111 |  |  |  |  |  |
| collections/list-build | go | 47.1 | 11.584 | 11.537 | 19091 | 606.8 | 2.9 MiB | 77.7 MiB | 20583 |
| collections/list-build | ts | 186.4 | 16.508 | 15.961 | 19091 | 864.7 | 2.9 MiB | 3.2 MiB |  |
| collections/list-build | cpython |  | 0.00739 | 0.00737 |  |  |  | 8.6 KiB |  |
| collections/list-build | go-native |  | 0.000633 | 0.000632 |  |  |  | 4.0 KiB | 2 |
| collections/list-build | gopher-lua |  | 0.0373 | 0.0372 |  |  |  | 35.4 KiB | 1045 |
| collections/list-build | quickjs |  | 0.0234 | 0.0233 |  |  |  |  |  |
| collections/list-build | starlark-go |  | 0.0175 | 0.0175 |  |  |  | 18.7 KiB | 18 |
| collections/list-build | ts-native |  | 0.000779 | 0.000767 |  |  |  | 2 B |  |
| collections/list-build | wasmoon |  | 0.0112 | 0.0100 |  |  |  |  |  |
| collections/list-update | go | 67.1 | 6.582 | 6.572 | 28553 | 230.5 | 23.8 KiB | 14.3 MiB | 76608 |
| collections/list-update | ts | 341.0 | 4.623 | 4.232 | 28553 | 161.9 | 23.8 KiB | 77.2 KiB |  |
| collections/list-update | cpython |  | 0.00922 | 0.00915 |  |  |  | 184 B |  |
| collections/list-update | go-native |  | 0.000370 | 0.000367 |  |  |  | 72 B | 2 |
| collections/list-update | gopher-lua |  | 0.0255 | 0.0255 |  |  |  | 22.4 KiB | 106 |
| collections/list-update | quickjs |  | 0.0174 | 0.0173 |  |  |  |  |  |
| collections/list-update | starlark-go |  | 0.0313 | 0.0307 |  |  |  | 704 B | 13 |
| collections/list-update | ts-native |  | 0.000730 | 0.000723 |  |  |  | 0 B |  |
| collections/list-update | wasmoon |  | 0.00566 | 0.00556 |  |  |  |  |  |
| collections/map-build | go | 59.8 | 7.018 | 7.002 | 14094 | 498.0 | 24.3 KiB | 34.9 MiB | 20497 |
| collections/map-build | ts | 241.0 | 18.104 | 17.524 | 14094 | 1284.5 | 24.3 KiB | 2.6 MiB |  |
| collections/map-build | cpython |  | 0.0148 | 0.0146 |  |  |  | 19.3 KiB |  |
| collections/map-build | go-native |  | 0.00572 | 0.00563 |  |  |  | 13.9 KiB | 205 |
| collections/map-build | gopher-lua |  | 0.0788 | 0.0786 |  |  |  | 90.5 KiB | 1291 |
| collections/map-build | quickjs |  | 0.0306 | 0.0305 |  |  |  |  |  |
| collections/map-build | starlark-go |  | 0.0375 | 0.0372 |  |  |  | 99.4 KiB | 827 |
| collections/map-build | ts-native |  | 0.00359 | 0.00349 |  |  |  | 9 B |  |
| collections/map-build | wasmoon |  | 0.0416 | 0.0393 |  |  |  |  |  |
| collections/map-update | go | 78.3 | 1.623 | 1.619 | 8056 | 201.5 | 12.1 KiB | 3.0 MiB | 11071 |
| collections/map-update | ts | 319.7 | 2.445 | 2.269 | 8056 | 303.5 | 12.1 KiB | 124 B |  |
| collections/map-update | cpython |  | 0.00423 | 0.00409 |  |  |  | 480 B |  |
| collections/map-update | go-native |  | 0.00276 | 0.00275 |  |  |  | 520 B | 5 |
| collections/map-update | gopher-lua |  | 0.0185 | 0.0184 |  |  |  | 10.2 KiB | 76 |
| collections/map-update | quickjs |  | 0.0183 | 0.0182 |  |  |  |  |  |
| collections/map-update | starlark-go |  | 0.0133 | 0.0132 |  |  |  | 1.7 KiB | 11 |
| collections/map-update | ts-native |  | 0.00142 | 0.00139 |  |  |  | 0 B |  |
| collections/map-update | wasmoon |  | 0.00337 | 0.00308 |  |  |  |  |  |
| core/calls | go | 52.4 | 5.372 | 5.350 | 46018 | 116.7 | 31.3 KiB | 4.1 MiB | 54019 |
| core/calls | ts | 206.8 | 9.744 | 9.074 | 46018 | 211.7 | 31.3 KiB | 92.8 KiB |  |
| core/calls | cpython |  | 0.0316 | 0.0314 |  |  |  | 0 B |  |
| core/calls | go-native |  | 0.000455 | 0.000454 |  |  |  | 8 B | 1 |
| core/calls | gopher-lua |  | 0.0734 | 0.0730 |  |  |  | 44.8 KiB | 180 |
| core/calls | quickjs |  | 0.0482 | 0.0480 |  |  |  |  |  |
| core/calls | starlark-go |  | 0.111 | 0.111 |  |  |  | 125.3 KiB | 2006 |
| core/calls | ts-native |  | 0.000537 | 0.000506 |  |  |  | 0 B |  |
| core/calls | wasmoon |  | 0.0242 | 0.0240 |  |  |  |  |  |
| core/fib | go | 51.0 | 5.204 | 5.197 | 46365 | 112.2 | 46.2 KiB | 3.4 MiB | 62250 |
| core/fib | ts | 210.0 | 9.750 | 9.257 | 46365 | 210.3 | 46.2 KiB | 329.0 KiB |  |
| core/fib | cpython |  | 0.0248 | 0.0248 |  |  |  | 0 B |  |
| core/fib | go-native |  | 0.00127 | 0.00127 |  |  |  | 8 B | 1 |
| core/fib | gopher-lua |  | 0.0731 | 0.0729 |  |  |  | 63 B | 1 |
| core/fib | quickjs |  | 0.0406 | 0.0404 |  |  |  |  |  |
| core/fib | starlark-go |  | 0.139 | 0.139 |  |  |  | 154.2 KiB | 1975 |
| core/fib | ts-native |  | 0.00187 | 0.00187 |  |  |  | 0 B |  |
| core/fib | wasmoon |  | 0.0258 | 0.0257 |  |  |  |  |  |
| core/fib@slice=10 | go | 51.1 | 10.256 | 10.221 | 46365 | 221.2 | 46.2 KiB | 18.3 MiB | 189363 |
| core/fib@slice=10 | ts | 160.4 | 19.671 | 18.332 | 46365 | 424.3 | 46.2 KiB | 341.9 KiB |  |
| core/fib@slice=100 | go | 51.0 | 6.104 | 6.077 | 46365 | 131.6 | 46.2 KiB | 6.9 MiB | 79185 |
| core/fib@slice=100 | ts | 150.0 | 11.286 | 10.613 | 46365 | 243.4 | 46.2 KiB | 46.5 KiB |  |
| core/fib@slice=1000 | go | 51.3 | 5.318 | 5.312 | 46365 | 114.7 | 46.2 KiB | 4.0 MiB | 64317 |
| core/fib@slice=1000 | ts | 147.5 | 10.146 | 9.777 | 46365 | 218.8 | 46.2 KiB | 12.5 KiB |  |
| core/fib@slice=10000 | go | 51.0 | 5.228 | 5.224 | 46365 | 112.8 | 46.2 KiB | 3.5 MiB | 62445 |
| core/fib@slice=10000 | ts | 145.0 | 9.764 | 9.394 | 46365 | 210.6 | 46.2 KiB | 0 B |  |
| core/lambdas | go | 58.4 | 7.738 | 7.725 | 58027 | 133.4 | 62.6 KiB | 6.4 MiB | 84012 |
| core/lambdas | ts | 285.8 | 17.336 | 16.543 | 58027 | 298.8 | 62.6 KiB | 364.1 KiB |  |
| core/lambdas | cpython |  | 0.0438 | 0.0429 |  |  |  | 208 B |  |
| core/lambdas | go-native |  | 0.000477 | 0.000475 |  |  |  | 8 B | 1 |
| core/lambdas | gopher-lua |  | 0.0865 | 0.0862 |  |  |  | 60.3 KiB | 244 |
| core/lambdas | quickjs |  | 0.0523 | 0.0520 |  |  |  |  |  |
| core/lambdas | starlark-go |  | 0.136 | 0.135 |  |  |  | 156.6 KiB | 2010 |
| core/lambdas | ts-native |  | 0.000945 | 0.000932 |  |  |  | 3 B |  |
| core/lambdas | wasmoon |  | 0.0293 | 0.0271 |  |  |  |  |  |
| core/loop | go | 43.4 | 7.479 | 7.464 | 48016 | 155.8 | 62.5 KiB | 1.9 MiB | 79973 |
| core/loop | ts | 163.5 | 14.805 | 13.774 | 48016 | 308.3 | 62.5 KiB | 371.3 KiB |  |
| core/loop | cpython |  | 0.0183 | 0.0182 |  |  |  | 0 B |  |
| core/loop | go-native |  | 0.000478 | 0.000469 |  |  |  | 8 B | 1 |
| core/loop | gopher-lua |  | 0.0259 | 0.0259 |  |  |  | 44.8 KiB | 180 |
| core/loop | quickjs |  | 0.0191 | 0.0178 |  |  |  |  |  |
| core/loop | starlark-go |  | 0.0389 | 0.0386 |  |  |  | 256 B | 6 |
| core/loop | ts-native |  | 0.000537 | 0.000504 |  |  |  | 1 B |  |
| core/loop | wasmoon |  | 0.00712 | 0.00704 |  |  |  |  |  |
| host/conversion | go | 60.1 | 6.590 | 6.574 | 25018 | 263.4 | 220.3 KiB | 13.1 MiB | 117149 |
| host/conversion | ts | 294.5 | 10.207 | 9.714 | 25018 | 408.0 | 220.3 KiB | 22.0 KiB |  |
| host/immediate | go | 45.5 | 2.006 | 1.998 | 13518 | 148.4 | 15.7 KiB | 1.5 MiB | 28241 |
| host/immediate | ts | 193.0 | 3.670 | 3.272 | 13518 | 271.5 | 15.7 KiB | 76.8 KiB |  |
| host/properties | go | 41.8 | 1.553 | 1.551 | 9018 | 172.2 | 15.7 KiB | 918.2 KiB | 18421 |
| host/properties | ts | 171.8 | 3.407 | 3.164 | 9018 | 377.8 | 15.7 KiB | 160.6 KiB |  |
| host/pump | go | 13.5 | 0.00388 | 0.00386 | 7 | 553.6 | 0 B | 12.5 KiB | 69 |
| host/pump | ts | 29.6 | 0.00647 | 0.00572 | 7 | 923.8 | 0 B | 1.6 KiB |  |
| host/suspending | go | 45.6 | 3.920 | 3.913 | 13518 | 290.0 | 15.7 KiB | 6.1 MiB | 71479 |
| host/suspending | ts | 190.8 | 6.346 | 5.532 | 13518 | 469.4 | 15.7 KiB | 228.5 KiB |  |
| lifecycle/load-large | go | 4310.3 | 0.742 | 0.740 | 4609 | 160.9 | 16.3 KiB | 470.4 KiB | 7313 |
| lifecycle/load-large | ts | 26447.0 | 1.242 | 1.162 | 4609 | 269.5 | 16.3 KiB | 59.9 KiB |  |
| lifecycle/load-small | go | 17.4 | 0.00398 | 0.00398 | 7 | 568.6 | 0 B | 12.6 KiB | 72 |
| lifecycle/load-small | ts | 49.6 | 0.00690 | 0.00564 | 7 | 985.0 | 0 B | 2.2 KiB |  |
| lifecycle/restore | go | 87.0 | 49.032 | 48.896 | 8015 | 6117.6 | 7.8 KiB | 66.1 MiB | 575459 |
| lifecycle/restore | ts | 423.9 | 11.730 | 11.289 | 8015 | 1463.5 | 7.8 KiB | 57.8 KiB |  |
| lifecycle/rollback | go | 93.3 | 22.891 | 22.828 | 102023 | 224.4 | 39.9 KiB | 50.7 MiB | 343379 |
| lifecycle/rollback | ts | 417.0 | 61.434 | 57.957 | 102023 | 602.2 | 39.9 KiB | 10.7 KiB |  |
| macro/game-tick | go | 86.6 | 8.460 | 8.436 | 67042 | 126.2 | 78.4 KiB | 7.9 MiB | 81910 |
| macro/game-tick | ts | 374.0 | 15.430 | 14.439 | 67042 | 230.2 | 78.4 KiB | 8.5 KiB |  |
| macro/game-tick | cpython |  | 0.0501 | 0.0499 |  |  |  | 0 B |  |
| macro/game-tick | go-native |  | 0.000240 | 0.000238 |  |  |  | 8 B | 1 |
| macro/game-tick | gopher-lua |  | 0.127 | 0.126 |  |  |  | 28.7 KiB | 128 |
| macro/game-tick | quickjs |  | 0.0422 | 0.0421 |  |  |  |  |  |
| macro/game-tick | starlark-go |  | 0.152 | 0.149 |  |  |  | 94.5 KiB | 1007 |
| macro/game-tick | ts-native |  | 0.000327 | 0.000324 |  |  |  | 0 B |  |
| macro/game-tick | wasmoon |  | 0.0232 | 0.0230 |  |  |  |  |  |
| macro/report | go | 55.1 | 1.807 | 1.804 | 86555 | 20.9 | 1.2 MiB | 1.8 MiB | 16384 |
| macro/report | ts | 204.8 | 15.850 | 15.229 | 86555 | 183.1 | 1.2 MiB | 2.8 MiB |  |
| macro/report | cpython |  | 0.0194 | 0.0194 |  |  |  | 14.8 KiB |  |
| macro/report | go-native |  | 0.00934 | 0.00927 |  |  |  | 8.8 KiB | 85 |
| macro/report | gopher-lua |  | 0.127 | 0.124 |  |  |  | 33.0 KiB | 1290 |
| macro/report | quickjs |  | 0.0389 | 0.0385 |  |  |  |  |  |
| macro/report | starlark-go |  | 0.0576 | 0.0573 |  |  |  | 66.2 KiB | 3084 |
| macro/report | ts-native |  | 0.00281 | 0.00269 |  |  |  | 5 B |  |
| macro/report | wasmoon |  | 0.0400 | 0.0343 |  |  |  |  |  |
| macro/transform | go | 74.0 | 18.248 | 18.188 | 20664 | 883.1 | 6.1 MiB | 64.0 MiB | 207984 |
| macro/transform | ts | 293.8 | 14.732 | 14.388 | 20664 | 712.9 | 6.1 MiB | 2.4 MiB |  |
| macro/transform | cpython |  | 0.0184 | 0.0184 |  |  |  | 48.0 KiB |  |
| macro/transform | go-native |  | 0.000692 | 0.000688 |  |  |  | 7.4 KiB | 3 |
| macro/transform | gopher-lua |  | 0.120 | 0.120 |  |  |  | 268.0 KiB | 4538 |
| macro/transform | quickjs |  | 0.0520 | 0.0519 |  |  |  |  |  |
| macro/transform | starlark-go |  | 0.0526 | 0.0523 |  |  |  | 168.7 KiB | 328 |
| macro/transform | ts-native |  | 0.00246 | 0.00241 |  |  |  | 1 B |  |
| macro/transform | wasmoon |  | 0.0317 | 0.0249 |  |  |  |  |  |
| messaging/joins | go | 79.0 | 23.801 | 23.769 | 127218 | 187.1 | 239.1 KiB | 48.7 MiB | 344032 |
| messaging/joins | ts | 342.0 | 33.822 | 31.700 | 127218 | 265.9 | 239.1 KiB | 12.8 KiB |  |
| messaging/parents | go | 52.6 | 16.089 | 16.019 | 67518 | 238.3 | 93.8 KiB | 30.5 MiB | 277293 |
| messaging/parents | ts | 239.3 | 23.977 | 22.813 | 67518 | 355.1 | 93.8 KiB | 102.1 KiB |  |
| messaging/sends | go | 61.5 | 14.309 | 14.249 | 67518 | 211.9 | 93.8 KiB | 32.2 MiB | 238293 |
| messaging/sends | ts | 265.8 | 22.033 | 18.356 | 67518 | 326.3 | 93.8 KiB | 257.5 KiB |  |
| messaging/suspend | go | 41.5 | 14.895 | 14.850 | 48018 | 310.2 | 31.3 KiB | 20.2 MiB | 384049 |
| messaging/suspend | ts | 160.5 | 24.454 | 23.031 | 48018 | 509.3 | 31.3 KiB | 1.2 MiB |  |
| numbers/add | go | 45.4 | 4.286 | 4.281 | 26030 | 164.6 | 31.4 KiB | 1.8 MiB | 46096 |
| numbers/add | ts | 198.2 | 10.316 | 9.802 | 26030 | 396.3 | 31.4 KiB | 367.1 KiB |  |
| numbers/add | cpython |  | 0.0208 | 0.0201 |  |  |  | 0 B |  |
| numbers/add | go-native |  | 0.00108 | 0.00107 |  |  |  | 8 B | 1 |
| numbers/add | gopher-lua |  | 0.0266 | 0.0265 |  |  |  | 43.9 KiB | 177 |
| numbers/add | quickjs |  | 0.0207 | 0.0204 |  |  |  |  |  |
| numbers/add | starlark-go |  | 0.0444 | 0.0442 |  |  |  | 15.9 KiB | 2010 |
| numbers/add | ts-native |  | 0.000991 | 0.000985 |  |  |  | 0 B |  |
| numbers/add | wasmoon |  | 0.00728 | 0.00712 |  |  |  |  |  |
| numbers/divide | go | 46.8 | 4.531 | 4.526 | 18031 | 251.3 | 31.4 KiB | 4.0 MiB | 145726 |
| numbers/divide | ts | 175.9 | 8.914 | 8.253 | 18031 | 494.4 | 31.4 KiB | 609.5 KiB |  |
| numbers/divide | cpython |  | 0.0155 | 0.0153 |  |  |  | 0 B |  |
| numbers/divide | go-native |  | 0.000699 | 0.000698 |  |  |  | 8 B | 1 |
| numbers/divide | gopher-lua |  | 0.0198 | 0.0197 |  |  |  | 28.3 KiB | 115 |
| numbers/divide | quickjs |  | 0.0143 | 0.0143 |  |  |  |  |  |
| numbers/divide | starlark-go |  | 0.0376 | 0.0374 |  |  |  | 15.9 KiB | 2010 |
| numbers/divide | ts-native |  | 0.000538 | 0.000517 |  |  |  | 1 B |  |
| numbers/divide | wasmoon |  | 0.00555 | 0.00544 |  |  |  |  |  |
| numbers/multiply | go | 47.0 | 2.961 | 2.955 | 18031 | 164.2 | 31.4 KiB | 1.2 MiB | 37088 |
| numbers/multiply | ts | 181.8 | 8.680 | 8.367 | 18031 | 481.4 | 31.4 KiB | 509.8 KiB |  |
| numbers/multiply | cpython |  | 0.0163 | 0.0156 |  |  |  | 0 B |  |
| numbers/multiply | go-native |  | 0.000699 | 0.000699 |  |  |  | 8 B | 1 |
| numbers/multiply | gopher-lua |  | 0.0183 | 0.0182 |  |  |  | 29.1 KiB | 118 |
| numbers/multiply | quickjs |  | 0.0189 | 0.0189 |  |  |  |  |  |
| numbers/multiply | starlark-go |  | 0.0367 | 0.0362 |  |  |  | 15.9 KiB | 2010 |
| numbers/multiply | ts-native |  | 0.000540 | 0.000519 |  |  |  | 0 B |  |
| numbers/multiply | wasmoon |  | 0.00622 | 0.00611 |  |  |  |  |  |
| numbers/quantity | go | 57.8 | 5.847 | 5.836 | 14579 | 401.1 | 39.1 KiB | 5.4 MiB | 214416 |
| numbers/quantity | ts | 227.4 | 15.276 | 14.676 | 14579 | 1047.8 | 39.1 KiB | 1021.2 KiB |  |
| numbers/quantity | cpython |  | 0.0101 | 0.00966 |  |  |  | 0 B |  |
| numbers/quantity | go-native |  | 0.000248 | 0.000248 |  |  |  | 8 B | 1 |
| numbers/quantity | gopher-lua |  | 0.0114 | 0.0114 |  |  |  | 16.5 KiB | 67 |
| numbers/quantity | quickjs |  | 0.00680 | 0.00672 |  |  |  |  |  |
| numbers/quantity | starlark-go |  | 0.0248 | 0.0245 |  |  |  | 8.1 KiB | 1009 |
| numbers/quantity | ts-native |  | 0.000312 | 0.000306 |  |  |  | 0 B |  |
| numbers/quantity | wasmoon |  | 0.00453 | 0.00438 |  |  |  |  |  |
| text/build | go | 41.4 | 1.069 | 1.066 | 28928 | 36.9 | 374.8 KiB | 853.4 KiB | 9048 |
| text/build | ts | 158.8 | 4.962 | 4.759 | 28928 | 171.5 | 374.8 KiB | 390.8 KiB |  |
| text/build | cpython |  | 0.0108 | 0.0100 |  |  |  | 1.5 KiB |  |
| text/build | go-native |  | 0.0372 | 0.0372 |  |  |  | 387.1 KiB | 500 |
| text/build | gopher-lua |  | 0.0550 | 0.0547 |  |  |  | 400.8 KiB | 1024 |
| text/build | quickjs |  | 0.0200 | 0.0199 |  |  |  |  |  |
| text/build | starlark-go |  | 0.0525 | 0.0522 |  |  |  | 395.1 KiB | 1006 |
| text/build | ts-native |  | 0.00119 | 0.00115 |  |  |  | 4 B |  |
| text/build | wasmoon |  | 0.0405 | 0.0376 |  |  |  |  |  |
| text/graphemes | go | 50.6 | 7.501 | 7.447 | 43518 | 172.4 | 144.1 KiB | 4.9 MiB | 83423 |
| text/graphemes | ts | 177.5 | 13.833 | 12.960 | 43518 | 317.9 | 144.1 KiB | 966.2 KiB |  |
| text/index | go | 52.8 | 6.752 | 6.727 | 26640 | 253.5 | 49.9 KiB | 6.2 MiB | 195185 |
| text/index | ts | 202.1 | 14.846 | 13.796 | 26640 | 557.3 | 49.9 KiB | 177.7 KiB |  |
| text/index | cpython |  | 0.0166 | 0.0165 |  |  |  | 0 B |  |
| text/index | go-native |  | 0.000394 | 0.000394 |  |  |  | 0 B | 0 |
| text/index | gopher-lua |  | 0.112 | 0.112 |  |  |  | 29.3 KiB | 1055 |
| text/index | quickjs |  | 0.0388 | 0.0386 |  |  |  |  |  |
| text/index | starlark-go |  | 0.0474 | 0.0474 |  |  |  | 15.9 KiB | 1006 |
| text/index | ts-native |  | 0.000679 | 0.000637 |  |  |  | 0 B |  |
| text/index | wasmoon |  | 0.0321 | 0.0305 |  |  |  |  |  |
| text/iterate | go | 48.8 | 4.921 | 4.883 | 30318 | 162.3 | 93.0 KiB | 3.5 MiB | 54622 |
| text/iterate | ts | 172.8 | 9.395 | 8.927 | 30318 | 309.9 | 93.0 KiB | 675.9 KiB |  |
| text/iterate | cpython |  | 0.0187 | 0.0185 |  |  |  | 48 B |  |
| text/iterate | go-native |  | 0.000476 | 0.000475 |  |  |  | 8 B | 1 |
| text/iterate | gopher-lua |  | 0.167 | 0.166 |  |  |  | 187.3 KiB | 9847 |
| text/iterate | quickjs |  | 0.0564 | 0.0535 |  |  |  |  |  |
| text/iterate | starlark-go |  | 0.106 | 0.106 |  |  |  | 62.0 KiB | 3607 |
| text/iterate | ts-native |  | 0.00107 | 0.00106 |  |  |  | 0 B |  |
| text/iterate | wasmoon |  | 0.0426 | 0.0393 |  |  |  |  |  |
| text/patterns | go | 49.7 | 4.246 | 4.239 | 13818 | 307.3 | 225.9 KiB | 7.7 MiB | 66597 |
| text/patterns | ts | 201.2 | 6.485 | 6.101 | 13818 | 469.3 | 225.9 KiB | 604.6 KiB |  |
| text/patterns | cpython |  | 0.0482 | 0.0477 |  |  |  | 1.2 KiB |  |
| text/patterns | go-native |  | 0.0598 | 0.0595 |  |  |  | 37.7 KiB | 1201 |
| text/patterns | gopher-lua |  | 0.249 | 0.248 |  |  |  | 390.8 KiB | 17736 |
| text/patterns | quickjs |  | 0.206 | 0.203 |  |  |  |  |  |
| text/patterns | starlark-go |  | 0.181 | 0.180 |  |  |  | 87.0 KiB | 4507 |
| text/patterns | ts-native |  | 0.0139 | 0.0137 |  |  |  | 14 B |  |
| text/patterns | wasmoon |  | 0.0605 | 0.0580 |  |  |  |  |  |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- numbers/quantity on ts: 1047.8 ns/Fuel, 3.2× the median
- collections/map-build on ts: 1284.5 ns/Fuel, 3.9× the median
- lifecycle/load-small on ts: 985.0 ns/Fuel, 3.0× the median
- collections/list-build on go: 606.8 ns/Fuel, 3.2× the median
- macro/transform on go: 883.1 ns/Fuel, 4.7× the median
- lifecycle/load-small on go: 568.6 ns/Fuel, 3.0× the median

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
