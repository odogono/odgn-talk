# Benchmark results, 2026-10-08

Commit `5448dd9-dirty` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.2, cost model 0, go go1.27.1, language 1.0-rc.2, cpython 3.14.8, gopher-lua v1.1.2, quickjs-emscripten 0.32.0, starlark-go v0.0.0-20261005163335-bcb1a1a55bf9, wasmoon 1.16.0.
Settings: count 10, runners go,ts,peers, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | go | 89.0 | 16.286 | 16.270 | 89459 | 182.1 | 195.6 KiB | 9.7 MiB | 133765 |
| collections/iterate | ts | 441.4 | 28.382 | 24.296 | 89459 | 317.3 | 195.6 KiB | 451.1 KiB |  |
| collections/iterate | cpython |  | 0.0544 | 0.0540 |  |  |  | 2.5 KiB |  |
| collections/iterate | go-native |  | 0.0171 | 0.0170 |  |  |  | 1.8 KiB | 4 |
| collections/iterate | gopher-lua |  | 0.396 | 0.394 |  |  |  | 108.8 KiB | 6741 |
| collections/iterate | quickjs |  | 0.127 | 0.124 |  |  |  |  |  |
| collections/iterate | starlark-go |  | 0.187 | 0.184 |  |  |  | 270.5 KiB | 783 |
| collections/iterate | ts-native |  | 0.00744 | 0.00725 |  |  |  | 6 B |  |
| collections/iterate | wasmoon |  | 0.113 | 0.109 |  |  |  |  |  |
| collections/list-build | go | 47.5 | 11.403 | 11.352 | 19091 | 597.3 | 2.9 MiB | 77.7 MiB | 20583 |
| collections/list-build | ts | 196.0 | 16.337 | 15.884 | 19091 | 855.7 | 2.9 MiB | 3.0 MiB |  |
| collections/list-build | cpython |  | 0.00747 | 0.00745 |  |  |  | 8.6 KiB |  |
| collections/list-build | go-native |  | 0.000617 | 0.000616 |  |  |  | 4.0 KiB | 2 |
| collections/list-build | gopher-lua |  | 0.0497 | 0.0454 |  |  |  | 35.4 KiB | 1045 |
| collections/list-build | quickjs |  | 0.0237 | 0.0236 |  |  |  |  |  |
| collections/list-build | starlark-go |  | 0.0188 | 0.0182 |  |  |  | 18.7 KiB | 18 |
| collections/list-build | ts-native |  | 0.000798 | 0.000777 |  |  |  | 2 B |  |
| collections/list-build | wasmoon |  | 0.0112 | 0.00992 |  |  |  |  |  |
| collections/list-update | go | 67.6 | 6.595 | 6.571 | 28553 | 231.0 | 23.8 KiB | 14.3 MiB | 76607 |
| collections/list-update | ts | 377.5 | 4.629 | 4.279 | 28553 | 162.1 | 23.8 KiB | 44.5 KiB |  |
| collections/list-update | cpython |  | 0.00921 | 0.00905 |  |  |  | 184 B |  |
| collections/list-update | go-native |  | 0.000379 | 0.000378 |  |  |  | 72 B | 2 |
| collections/list-update | gopher-lua |  | 0.0289 | 0.0281 |  |  |  | 22.4 KiB | 106 |
| collections/list-update | quickjs |  | 0.0176 | 0.0174 |  |  |  |  |  |
| collections/list-update | starlark-go |  | 0.0323 | 0.0321 |  |  |  | 704 B | 13 |
| collections/list-update | ts-native |  | 0.000728 | 0.000720 |  |  |  | 0 B |  |
| collections/list-update | wasmoon |  | 0.00586 | 0.00567 |  |  |  |  |  |
| collections/map-build | go | 60.7 | 7.022 | 6.992 | 14094 | 498.2 | 24.3 KiB | 34.9 MiB | 20497 |
| collections/map-build | ts | 258.3 | 17.951 | 17.306 | 14094 | 1273.7 | 24.3 KiB | 2.8 MiB |  |
| collections/map-build | cpython |  | 0.0146 | 0.0146 |  |  |  | 19.3 KiB |  |
| collections/map-build | go-native |  | 0.00563 | 0.00557 |  |  |  | 13.9 KiB | 205 |
| collections/map-build | gopher-lua |  | 0.0884 | 0.0832 |  |  |  | 90.5 KiB | 1291 |
| collections/map-build | quickjs |  | 0.0304 | 0.0303 |  |  |  |  |  |
| collections/map-build | starlark-go |  | 0.0388 | 0.0388 |  |  |  | 99.4 KiB | 827 |
| collections/map-build | ts-native |  | 0.00357 | 0.00350 |  |  |  | 15 B |  |
| collections/map-build | wasmoon |  | 0.0425 | 0.0405 |  |  |  |  |  |
| collections/map-update | go | 79.8 | 1.624 | 1.621 | 8056 | 201.6 | 12.1 KiB | 3.0 MiB | 11071 |
| collections/map-update | ts | 378.9 | 2.443 | 2.263 | 8056 | 303.2 | 12.1 KiB | 9.3 KiB |  |
| collections/map-update | cpython |  | 0.00415 | 0.00414 |  |  |  | 480 B |  |
| collections/map-update | go-native |  | 0.00282 | 0.00275 |  |  |  | 520 B | 5 |
| collections/map-update | gopher-lua |  | 0.0197 | 0.0187 |  |  |  | 10.2 KiB | 76 |
| collections/map-update | quickjs |  | 0.0182 | 0.0182 |  |  |  |  |  |
| collections/map-update | starlark-go |  | 0.0144 | 0.0142 |  |  |  | 1.7 KiB | 11 |
| collections/map-update | ts-native |  | 0.00141 | 0.00139 |  |  |  | 0 B |  |
| collections/map-update | wasmoon |  | 0.00333 | 0.00304 |  |  |  |  |  |
| core/calls | go | 52.8 | 5.378 | 5.366 | 46018 | 116.9 | 31.3 KiB | 4.1 MiB | 54019 |
| core/calls | ts | 203.0 | 9.672 | 8.946 | 46018 | 210.2 | 31.3 KiB | 123.6 KiB |  |
| core/calls | cpython |  | 0.0309 | 0.0307 |  |  |  | 0 B |  |
| core/calls | go-native |  | 0.000488 | 0.000487 |  |  |  | 8 B | 1 |
| core/calls | gopher-lua |  | 0.0859 | 0.0774 |  |  |  | 44.8 KiB | 180 |
| core/calls | quickjs |  | 0.0477 | 0.0472 |  |  |  |  |  |
| core/calls | starlark-go |  | 0.130 | 0.123 |  |  |  | 125.3 KiB | 2006 |
| core/calls | ts-native |  | 0.000542 | 0.000509 |  |  |  | 0 B |  |
| core/calls | wasmoon |  | 0.0233 | 0.0230 |  |  |  |  |  |
| core/fib | go | 51.3 | 5.228 | 5.218 | 46365 | 112.8 | 46.2 KiB | 3.4 MiB | 62250 |
| core/fib | ts | 211.5 | 9.759 | 9.097 | 46365 | 210.5 | 46.2 KiB | 232.2 KiB |  |
| core/fib | cpython |  | 0.0248 | 0.0248 |  |  |  | 0 B |  |
| core/fib | go-native |  | 0.00130 | 0.00129 |  |  |  | 8 B | 1 |
| core/fib | gopher-lua |  | 0.0843 | 0.0824 |  |  |  | 63 B | 1 |
| core/fib | quickjs |  | 0.0411 | 0.0410 |  |  |  |  |  |
| core/fib | starlark-go |  | 0.149 | 0.146 |  |  |  | 154.2 KiB | 1975 |
| core/fib | ts-native |  | 0.00188 | 0.00187 |  |  |  | 0 B |  |
| core/fib | wasmoon |  | 0.0258 | 0.0256 |  |  |  |  |  |
| core/fib@slice=10 | go | 51.5 | 10.253 | 10.224 | 46365 | 221.1 | 46.2 KiB | 18.3 MiB | 189362 |
| core/fib@slice=10 | ts | 158.3 | 18.868 | 17.695 | 46365 | 406.9 | 46.2 KiB | 321.3 KiB |  |
| core/fib@slice=100 | go | 51.4 | 6.117 | 6.098 | 46365 | 131.9 | 46.2 KiB | 6.9 MiB | 79185 |
| core/fib@slice=100 | ts | 149.4 | 10.987 | 10.265 | 46365 | 237.0 | 46.2 KiB | 256 B |  |
| core/fib@slice=1000 | go | 51.2 | 5.357 | 5.342 | 46365 | 115.5 | 46.2 KiB | 4.0 MiB | 64317 |
| core/fib@slice=1000 | ts | 144.9 | 9.983 | 9.584 | 46365 | 215.3 | 46.2 KiB | 1.1 KiB |  |
| core/fib@slice=10000 | go | 51.7 | 5.237 | 5.215 | 46365 | 113.0 | 46.2 KiB | 3.5 MiB | 62445 |
| core/fib@slice=10000 | ts | 141.9 | 9.563 | 9.195 | 46365 | 206.3 | 46.2 KiB | 86.4 KiB |  |
| core/lambdas | go | 59.8 | 7.763 | 7.726 | 58027 | 133.8 | 62.6 KiB | 6.4 MiB | 84012 |
| core/lambdas | ts | 285.6 | 17.289 | 16.297 | 58027 | 297.9 | 62.6 KiB | 861.7 KiB |  |
| core/lambdas | cpython |  | 0.0404 | 0.0392 |  |  |  | 208 B |  |
| core/lambdas | go-native |  | 0.000499 | 0.000498 |  |  |  | 8 B | 1 |
| core/lambdas | gopher-lua |  | 0.104 | 0.0921 |  |  |  | 60.3 KiB | 244 |
| core/lambdas | quickjs |  | 0.0509 | 0.0507 |  |  |  |  |  |
| core/lambdas | starlark-go |  | 0.157 | 0.156 |  |  |  | 156.6 KiB | 2010 |
| core/lambdas | ts-native |  | 0.000957 | 0.000925 |  |  |  | 2 B |  |
| core/lambdas | wasmoon |  | 0.0287 | 0.0264 |  |  |  |  |  |
| core/loop | go | 43.7 | 7.507 | 7.497 | 48016 | 156.3 | 62.5 KiB | 1.9 MiB | 79973 |
| core/loop | ts | 159.9 | 14.475 | 13.518 | 48016 | 301.5 | 62.5 KiB | 539.4 KiB |  |
| core/loop | cpython |  | 0.0183 | 0.0182 |  |  |  | 0 B |  |
| core/loop | go-native |  | 0.000500 | 0.000499 |  |  |  | 8 B | 1 |
| core/loop | gopher-lua |  | 0.0533 | 0.0258 |  |  |  | 44.8 KiB | 180 |
| core/loop | quickjs |  | 0.0193 | 0.0178 |  |  |  |  |  |
| core/loop | starlark-go |  | 0.0433 | 0.0423 |  |  |  | 256 B | 6 |
| core/loop | ts-native |  | 0.000540 | 0.000505 |  |  |  | 1 B |  |
| core/loop | wasmoon |  | 0.00705 | 0.00700 |  |  |  |  |  |
| host/conversion | go | 60.6 | 6.723 | 6.567 | 25018 | 268.7 | 220.3 KiB | 13.1 MiB | 117148 |
| host/conversion | ts | 324.9 | 10.259 | 9.876 | 25018 | 410.0 | 220.3 KiB | 524.6 KiB |  |
| host/immediate | go | 45.9 | 2.011 | 2.003 | 13518 | 148.8 | 15.7 KiB | 1.5 MiB | 28241 |
| host/immediate | ts | 211.0 | 3.701 | 3.272 | 13518 | 273.8 | 15.7 KiB | 13.3 KiB |  |
| host/properties | go | 41.6 | 1.564 | 1.546 | 9018 | 173.4 | 15.7 KiB | 918.2 KiB | 18421 |
| host/properties | ts | 173.5 | 3.401 | 3.116 | 9018 | 377.1 | 15.7 KiB | 205.7 KiB |  |
| host/pump | go | 13.6 | 0.00389 | 0.00387 | 7 | 555.1 | 0 B | 12.5 KiB | 69 |
| host/pump | ts | 31.6 | 0.00634 | 0.00565 | 7 | 905.9 | 0 B | 1.6 KiB |  |
| host/suspending | go | 45.7 | 3.948 | 3.931 | 13518 | 292.0 | 15.7 KiB | 6.1 MiB | 71478 |
| host/suspending | ts | 214.8 | 6.335 | 5.604 | 13518 | 468.6 | 15.7 KiB | 215.0 KiB |  |
| lifecycle/load-large | go | 4324.0 | 0.760 | 0.758 | 4609 | 164.8 | 16.3 KiB | 470.4 KiB | 7313 |
| lifecycle/load-large | ts | 27140.7 | 1.253 | 1.171 | 4609 | 271.8 | 16.3 KiB | 47.1 KiB |  |
| lifecycle/load-small | go | 17.5 | 0.00420 | 0.00418 | 7 | 600.4 | 0 B | 12.6 KiB | 72 |
| lifecycle/load-small | ts | 50.2 | 0.00667 | 0.00570 | 7 | 953.5 | 0 B | 2.4 KiB |  |
| lifecycle/restore | go | 87.3 | 50.318 | 50.164 | 8015 | 6277.9 | 7.8 KiB | 66.4 MiB | 575678 |
| lifecycle/restore | ts | 464.0 | 12.967 | 12.503 | 8015 | 1617.8 | 7.8 KiB | 65.8 KiB |  |
| lifecycle/rollback | go | 86.9 | 40.979 | 40.594 | 27049 | 1515.0 | 39.2 KiB | 330.9 MiB | 57981 |
| lifecycle/rollback | ts | 417.5 | 60.398 | 58.902 | 27049 | 2232.9 | 39.2 KiB | 17.9 MiB |  |
| macro/game-tick | go | 87.0 | 11.876 | 10.300 | 67042 | 177.1 | 78.4 KiB | 7.9 MiB | 81910 |
| macro/game-tick | ts | 384.1 | 15.218 | 14.155 | 67042 | 227.0 | 78.4 KiB | 1.8 KiB |  |
| macro/game-tick | cpython |  | 0.0495 | 0.0490 |  |  |  | 0 B |  |
| macro/game-tick | go-native |  | 0.000246 | 0.000243 |  |  |  | 8 B | 1 |
| macro/game-tick | gopher-lua |  | 0.165 | 0.137 |  |  |  | 28.7 KiB | 128 |
| macro/game-tick | quickjs |  | 0.0418 | 0.0415 |  |  |  |  |  |
| macro/game-tick | starlark-go |  | 0.161 | 0.161 |  |  |  | 94.5 KiB | 1007 |
| macro/game-tick | ts-native |  | 0.000331 | 0.000325 |  |  |  | 0 B |  |
| macro/game-tick | wasmoon |  | 0.0233 | 0.0232 |  |  |  |  |  |
| macro/report | go | 55.7 | 2.385 | 2.296 | 86555 | 27.6 | 1.2 MiB | 1.8 MiB | 16384 |
| macro/report | ts | 208.2 | 15.719 | 15.076 | 86555 | 181.6 | 1.2 MiB | 1.5 MiB |  |
| macro/report | cpython |  | 0.0197 | 0.0196 |  |  |  | 14.8 KiB |  |
| macro/report | go-native |  | 0.00929 | 0.00918 |  |  |  | 8.8 KiB | 85 |
| macro/report | gopher-lua |  | 0.124 | 0.123 |  |  |  | 33.0 KiB | 1290 |
| macro/report | quickjs |  | 0.0382 | 0.0379 |  |  |  |  |  |
| macro/report | starlark-go |  | 0.0614 | 0.0609 |  |  |  | 66.2 KiB | 3084 |
| macro/report | ts-native |  | 0.00279 | 0.00265 |  |  |  | 4 B |  |
| macro/report | wasmoon |  | 0.0401 | 0.0340 |  |  |  |  |  |
| macro/transform | go | 74.2 | 37.263 | 35.351 | 20664 | 1803.3 | 6.1 MiB | 64.0 MiB | 207985 |
| macro/transform | ts | 288.8 | 14.656 | 14.198 | 20664 | 709.3 | 6.1 MiB | 3.1 MiB |  |
| macro/transform | cpython |  | 0.0187 | 0.0185 |  |  |  | 48.0 KiB |  |
| macro/transform | go-native |  | 0.000686 | 0.000684 |  |  |  | 7.4 KiB | 3 |
| macro/transform | gopher-lua |  | 0.119 | 0.118 |  |  |  | 268.0 KiB | 4538 |
| macro/transform | quickjs |  | 0.0526 | 0.0524 |  |  |  |  |  |
| macro/transform | starlark-go |  | 0.0558 | 0.0548 |  |  |  | 168.7 KiB | 328 |
| macro/transform | ts-native |  | 0.00216 | 0.00212 |  |  |  | 2 B |  |
| macro/transform | wasmoon |  | 0.0325 | 0.0256 |  |  |  |  |  |
| messaging/joins | go | 79.8 | 28.638 | 26.786 | 127218 | 225.1 | 239.1 KiB | 48.7 MiB | 344030 |
| messaging/joins | ts | 356.9 | 33.881 | 31.383 | 127218 | 266.3 | 239.1 KiB | 46.5 KiB |  |
| messaging/parents | go | 53.0 | 18.257 | 18.046 | 67518 | 270.4 | 93.8 KiB | 30.5 MiB | 277291 |
| messaging/parents | ts | 237.0 | 23.214 | 22.293 | 67518 | 343.8 | 93.8 KiB | 76.8 KiB |  |
| messaging/sends | go | 62.8 | 18.817 | 16.259 | 67518 | 278.7 | 93.8 KiB | 32.2 MiB | 238290 |
| messaging/sends | ts | 264.1 | 22.718 | 18.696 | 67518 | 336.5 | 93.8 KiB | 427.9 KiB |  |
| messaging/suspend | go | 41.7 | 16.596 | 16.295 | 48018 | 345.6 | 31.3 KiB | 20.2 MiB | 384047 |
| messaging/suspend | ts | 162.4 | 23.466 | 22.854 | 48018 | 488.7 | 31.3 KiB | 758.1 KiB |  |
| numbers/add | go | 45.9 | 4.404 | 4.286 | 26030 | 169.2 | 31.4 KiB | 1.8 MiB | 46096 |
| numbers/add | ts | 196.1 | 10.196 | 9.726 | 26030 | 391.7 | 31.4 KiB | 481.6 KiB |  |
| numbers/add | cpython |  | 0.0200 | 0.0199 |  |  |  | 0 B |  |
| numbers/add | go-native |  | 0.00116 | 0.00115 |  |  |  | 8 B | 1 |
| numbers/add | gopher-lua |  | 0.0298 | 0.0282 |  |  |  | 43.9 KiB | 177 |
| numbers/add | quickjs |  | 0.0207 | 0.0201 |  |  |  |  |  |
| numbers/add | starlark-go |  | 0.0511 | 0.0506 |  |  |  | 15.9 KiB | 2010 |
| numbers/add | ts-native |  | 0.000986 | 0.000978 |  |  |  | 0 B |  |
| numbers/add | wasmoon |  | 0.00697 | 0.00692 |  |  |  |  |  |
| numbers/divide | go | 47.3 | 4.552 | 4.541 | 18031 | 252.4 | 31.4 KiB | 4.0 MiB | 145726 |
| numbers/divide | ts | 177.7 | 8.606 | 8.170 | 18031 | 477.3 | 31.4 KiB | 294.1 KiB |  |
| numbers/divide | cpython |  | 0.0156 | 0.0156 |  |  |  | 0 B |  |
| numbers/divide | go-native |  | 0.000753 | 0.000752 |  |  |  | 8 B | 1 |
| numbers/divide | gopher-lua |  | 0.0216 | 0.0215 |  |  |  | 28.3 KiB | 115 |
| numbers/divide | quickjs |  | 0.0149 | 0.0148 |  |  |  |  |  |
| numbers/divide | starlark-go |  | 0.0505 | 0.0473 |  |  |  | 15.9 KiB | 2010 |
| numbers/divide | ts-native |  | 0.000534 | 0.000518 |  |  |  | 1 B |  |
| numbers/divide | wasmoon |  | 0.00569 | 0.00550 |  |  |  |  |  |
| numbers/multiply | go | 47.9 | 2.963 | 2.955 | 18031 | 164.3 | 31.4 KiB | 1.2 MiB | 37088 |
| numbers/multiply | ts | 181.9 | 8.677 | 8.316 | 18031 | 481.2 | 31.4 KiB | 532.0 KiB |  |
| numbers/multiply | cpython |  | 0.0154 | 0.0153 |  |  |  | 0 B |  |
| numbers/multiply | go-native |  | 0.000754 | 0.000752 |  |  |  | 8 B | 1 |
| numbers/multiply | gopher-lua |  | 0.0200 | 0.0198 |  |  |  | 29.1 KiB | 118 |
| numbers/multiply | quickjs |  | 0.0199 | 0.0191 |  |  |  |  |  |
| numbers/multiply | starlark-go |  | 0.0591 | 0.0530 |  |  |  | 15.9 KiB | 2010 |
| numbers/multiply | ts-native |  | 0.000537 | 0.000520 |  |  |  | 0 B |  |
| numbers/multiply | wasmoon |  | 0.00607 | 0.00588 |  |  |  |  |  |
| numbers/quantity | go | 58.2 | 5.870 | 5.841 | 14579 | 402.6 | 39.1 KiB | 5.4 MiB | 214416 |
| numbers/quantity | ts | 228.0 | 15.147 | 14.433 | 14579 | 1039.0 | 39.1 KiB | 816.7 KiB |  |
| numbers/quantity | cpython |  | 0.00971 | 0.00967 |  |  |  | 0 B |  |
| numbers/quantity | go-native |  | 0.000262 | 0.000262 |  |  |  | 8 B | 1 |
| numbers/quantity | gopher-lua |  | 0.0127 | 0.0123 |  |  |  | 16.5 KiB | 67 |
| numbers/quantity | quickjs |  | 0.00665 | 0.00657 |  |  |  |  |  |
| numbers/quantity | starlark-go |  | 0.0337 | 0.0298 |  |  |  | 8.1 KiB | 1009 |
| numbers/quantity | ts-native |  | 0.000316 | 0.000306 |  |  |  | 0 B |  |
| numbers/quantity | wasmoon |  | 0.00440 | 0.00430 |  |  |  |  |  |
| text/build | go | 42.3 | 1.073 | 1.068 | 28928 | 37.1 | 374.8 KiB | 853.4 KiB | 9048 |
| text/build | ts | 164.0 | 4.897 | 4.720 | 28928 | 169.3 | 374.8 KiB | 506.1 KiB |  |
| text/build | cpython |  | 0.0102 | 0.0102 |  |  |  | 1.5 KiB |  |
| text/build | go-native |  | 0.0405 | 0.0401 |  |  |  | 387.1 KiB | 500 |
| text/build | gopher-lua |  | 0.0621 | 0.0538 |  |  |  | 400.8 KiB | 1024 |
| text/build | quickjs |  | 0.0200 | 0.0198 |  |  |  |  |  |
| text/build | starlark-go |  | 0.0670 | 0.0643 |  |  |  | 395.1 KiB | 1006 |
| text/build | ts-native |  | 0.00119 | 0.00114 |  |  |  | 0 B |  |
| text/build | wasmoon |  | 0.0402 | 0.0370 |  |  |  |  |  |
| text/graphemes | go | 50.8 | 7.468 | 7.441 | 43518 | 171.6 | 144.1 KiB | 4.9 MiB | 83423 |
| text/graphemes | ts | 197.5 | 13.793 | 12.842 | 43518 | 316.9 | 144.1 KiB | 549.2 KiB |  |
| text/index | go | 53.2 | 6.758 | 6.727 | 26640 | 253.7 | 49.9 KiB | 6.2 MiB | 195185 |
| text/index | ts | 228.6 | 14.939 | 14.057 | 26640 | 560.8 | 49.9 KiB | 393.2 KiB |  |
| text/index | cpython |  | 0.0164 | 0.0163 |  |  |  | 0 B |  |
| text/index | go-native |  | 0.000400 | 0.000395 |  |  |  | 0 B | 0 |
| text/index | gopher-lua |  | 0.112 | 0.112 |  |  |  | 29.3 KiB | 1055 |
| text/index | quickjs |  | 0.0388 | 0.0374 |  |  |  |  |  |
| text/index | starlark-go |  | 0.0552 | 0.0511 |  |  |  | 15.9 KiB | 1006 |
| text/index | ts-native |  | 0.000639 | 0.000635 |  |  |  | 0 B |  |
| text/index | wasmoon |  | 0.0317 | 0.0302 |  |  |  |  |  |
| text/iterate | go | 48.6 | 5.033 | 4.887 | 30318 | 166.0 | 93.0 KiB | 3.5 MiB | 54622 |
| text/iterate | ts | 193.5 | 9.301 | 8.749 | 30318 | 306.8 | 93.0 KiB | 531.2 KiB |  |
| text/iterate | cpython |  | 0.0188 | 0.0186 |  |  |  | 48 B |  |
| text/iterate | go-native |  | 0.000488 | 0.000487 |  |  |  | 8 B | 1 |
| text/iterate | gopher-lua |  | 0.179 | 0.174 |  |  |  | 187.3 KiB | 9847 |
| text/iterate | quickjs |  | 0.0566 | 0.0532 |  |  |  |  |  |
| text/iterate | starlark-go |  | 0.123 | 0.114 |  |  |  | 62.0 KiB | 3607 |
| text/iterate | ts-native |  | 0.00107 | 0.00107 |  |  |  | 0 B |  |
| text/iterate | wasmoon |  | 0.0428 | 0.0395 |  |  |  |  |  |
| text/patterns | go | 49.8 | 4.262 | 4.246 | 13818 | 308.5 | 225.9 KiB | 7.7 MiB | 66597 |
| text/patterns | ts | 217.0 | 6.438 | 6.036 | 13818 | 465.9 | 225.9 KiB | 501.3 KiB |  |
| text/patterns | cpython |  | 0.0492 | 0.0488 |  |  |  | 1.2 KiB |  |
| text/patterns | go-native |  | 0.0599 | 0.0592 |  |  |  | 37.7 KiB | 1201 |
| text/patterns | gopher-lua |  | 0.400 | 0.349 |  |  |  | 390.8 KiB | 17736 |
| text/patterns | quickjs |  | 0.203 | 0.199 |  |  |  |  |  |
| text/patterns | starlark-go |  | 0.201 | 0.188 |  |  |  | 87.0 KiB | 4507 |
| text/patterns | ts-native |  | 0.0137 | 0.0136 |  |  |  | 63 B |  |
| text/patterns | wasmoon |  | 0.0609 | 0.0585 |  |  |  |  |  |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- numbers/quantity on ts: 1039.0 ns/Fuel, 3.1× the median
- collections/map-build on ts: 1273.7 ns/Fuel, 3.8× the median
- lifecycle/rollback on ts: 2232.9 ns/Fuel, 6.6× the median
- macro/transform on go: 1803.3 ns/Fuel, 8.9× the median
- lifecycle/rollback on go: 1515.0 ns/Fuel, 7.5× the median

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
