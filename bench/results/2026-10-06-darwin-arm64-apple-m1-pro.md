# Benchmark results, 2026-10-06

Commit `0a5fec9` on Apple M1 Pro (10 cores, 32 GiB), darwin arm64.
Versions: bun 1.4.2, cost model 0, go go1.27.1, language 1.0-rc.2, cpython 3.14.8, gopher-lua v1.1.2, quickjs-emscripten 0.32.0, starlark-go v0.0.0-20261005163335-bcb1a1a55bf9, wasmoon 1.16.0.
Settings: count 10, runners go,ts,peers, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | go | 147.8 | 94.623 | 93.360 | 89459 | 1057.7 | 195.6 KiB | 291.9 MiB | 1228002 |
| collections/iterate | ts | 665.4 | 46.519 | 45.112 | 89459 | 520.0 | 195.6 KiB | 6.4 KiB |  |
| collections/iterate | cpython |  | 0.104 | 0.104 |  |  |  | 2.5 KiB |  |
| collections/iterate | go-native |  | 0.0265 | 0.0263 |  |  |  | 1.8 KiB | 4 |
| collections/iterate | gopher-lua |  | 0.628 | 0.626 |  |  |  | 108.9 KiB | 6741 |
| collections/iterate | quickjs |  | 0.255 | 0.248 |  |  |  |  |  |
| collections/iterate | starlark-go |  | 0.323 | 0.322 |  |  |  | 270.5 KiB | 783 |
| collections/iterate | ts-native |  | 0.0121 | 0.0108 |  |  |  | 5 B |  |
| collections/iterate | wasmoon |  | 0.200 | 0.194 |  |  |  |  |  |
| collections/list-build | go | 75.8 | 37.746 | 37.314 | 19091 | 1977.2 | 2.9 MiB | 115.8 MiB | 566530 |
| collections/list-build | ts | 323.7 | 27.597 | 26.948 | 19091 | 1445.5 | 2.9 MiB | 4.3 MiB |  |
| collections/list-build | cpython |  | 0.0130 | 0.0129 |  |  |  | 8.6 KiB |  |
| collections/list-build | go-native |  | 0.000859 | 0.000843 |  |  |  | 4.0 KiB | 2 |
| collections/list-build | gopher-lua |  | 0.0611 | 0.0608 |  |  |  | 35.4 KiB | 1045 |
| collections/list-build | quickjs |  | 0.0521 | 0.0505 |  |  |  |  |  |
| collections/list-build | starlark-go |  | 0.0334 | 0.0333 |  |  |  | 18.7 KiB | 18 |
| collections/list-build | ts-native |  | 0.00205 | 0.00196 |  |  |  | 18 B |  |
| collections/list-build | wasmoon |  | 0.0193 | 0.0191 |  |  |  |  |  |
| collections/list-update | go | 108.3 | 33.257 | 32.727 | 28553 | 1164.7 | 23.8 KiB | 96.0 MiB | 406022 |
| collections/list-update | ts | 556.0 | 7.935 | 7.321 | 28553 | 277.9 | 23.8 KiB | 93.3 KiB |  |
| collections/list-update | cpython |  | 0.0183 | 0.0181 |  |  |  | 184 B |  |
| collections/list-update | go-native |  | 0.000529 | 0.000526 |  |  |  | 72 B | 2 |
| collections/list-update | gopher-lua |  | 0.0467 | 0.0463 |  |  |  | 22.4 KiB | 106 |
| collections/list-update | quickjs |  | 0.0497 | 0.0494 |  |  |  |  |  |
| collections/list-update | starlark-go |  | 0.0576 | 0.0573 |  |  |  | 704 B | 13 |
| collections/list-update | ts-native |  | 0.00149 | 0.00147 |  |  |  | 0 B |  |
| collections/list-update | wasmoon |  | 0.0101 | 0.00989 |  |  |  |  |  |
| collections/map-build | go | 95.6 | 19.233 | 19.182 | 14094 | 1364.7 | 24.3 KiB | 62.7 MiB | 139630 |
| collections/map-build | ts | 399.0 | 28.320 | 27.042 | 14094 | 2009.4 | 24.3 KiB | 2.9 MiB |  |
| collections/map-build | cpython |  | 0.0260 | 0.0257 |  |  |  | 19.3 KiB |  |
| collections/map-build | go-native |  | 0.00938 | 0.00931 |  |  |  | 13.9 KiB | 205 |
| collections/map-build | gopher-lua |  | 0.125 | 0.124 |  |  |  | 90.5 KiB | 1291 |
| collections/map-build | quickjs |  | 0.0561 | 0.0537 |  |  |  |  |  |
| collections/map-build | starlark-go |  | 0.0665 | 0.0655 |  |  |  | 99.4 KiB | 827 |
| collections/map-build | ts-native |  | 0.00648 | 0.00619 |  |  |  | 21 B |  |
| collections/map-build | wasmoon |  | 0.0665 | 0.0623 |  |  |  |  |  |
| collections/map-update | go | 128.3 | 8.458 | 8.060 | 8056 | 1049.9 | 12.1 KiB | 22.0 MiB | 108754 |
| collections/map-update | ts | 511.3 | 4.331 | 3.739 | 8056 | 537.6 | 12.1 KiB | 11.1 KiB |  |
| collections/map-update | cpython |  | 0.00855 | 0.00850 |  |  |  | 480 B |  |
| collections/map-update | go-native |  | 0.00443 | 0.00441 |  |  |  | 520 B | 5 |
| collections/map-update | gopher-lua |  | 0.0311 | 0.0307 |  |  |  | 10.2 KiB | 76 |
| collections/map-update | quickjs |  | 0.0376 | 0.0373 |  |  |  |  |  |
| collections/map-update | starlark-go |  | 0.0257 | 0.0255 |  |  |  | 1.7 KiB | 11 |
| collections/map-update | ts-native |  | 0.00228 | 0.00223 |  |  |  | 0 B |  |
| collections/map-update | wasmoon |  | 0.00554 | 0.00508 |  |  |  |  |  |
| core/calls | go | 84.8 | 31.870 | 31.560 | 46018 | 692.6 | 31.3 KiB | 60.5 MiB | 643226 |
| core/calls | ts | 325.5 | 15.978 | 14.896 | 46018 | 347.2 | 31.3 KiB | 386.2 KiB |  |
| core/calls | cpython |  | 0.0633 | 0.0625 |  |  |  | 0 B |  |
| core/calls | go-native |  | 0.000666 | 0.000665 |  |  |  | 8 B | 1 |
| core/calls | gopher-lua |  | 0.131 | 0.130 |  |  |  | 44.8 KiB | 180 |
| core/calls | quickjs |  | 0.112 | 0.107 |  |  |  |  |  |
| core/calls | starlark-go |  | 0.184 | 0.184 |  |  |  | 125.3 KiB | 2006 |
| core/calls | ts-native |  | 0.000981 | 0.000965 |  |  |  | 1 B |  |
| core/calls | wasmoon |  | 0.0487 | 0.0471 |  |  |  |  |  |
| core/fib | go | 81.6 | 24.589 | 24.234 | 46365 | 530.3 | 46.2 KiB | 38.8 MiB | 516339 |
| core/fib | ts | 372.5 | 16.133 | 14.991 | 46365 | 348.0 | 46.2 KiB | 316.4 KiB |  |
| core/fib | cpython |  | 0.0475 | 0.0467 |  |  |  | 0 B |  |
| core/fib | go-native |  | 0.00208 | 0.00208 |  |  |  | 8 B | 1 |
| core/fib | gopher-lua |  | 0.125 | 0.124 |  |  |  | 63 B | 1 |
| core/fib | quickjs |  | 0.0810 | 0.0785 |  |  |  |  |  |
| core/fib | starlark-go |  | 0.235 | 0.234 |  |  |  | 154.2 KiB | 1975 |
| core/fib | ts-native |  | 0.00290 | 0.00284 |  |  |  | 0 B |  |
| core/fib | wasmoon |  | 0.0518 | 0.0501 |  |  |  |  |  |
| core/lambdas | go | 95.9 | 48.225 | 47.648 | 58027 | 831.1 | 62.6 KiB | 99.6 MiB | 935931 |
| core/lambdas | ts | 434.8 | 28.538 | 27.073 | 58027 | 491.8 | 62.6 KiB | 777.6 KiB |  |
| core/lambdas | cpython |  | 0.0802 | 0.0788 |  |  |  | 208 B |  |
| core/lambdas | go-native |  | 0.00125 | 0.00125 |  |  |  | 8 B | 1 |
| core/lambdas | gopher-lua |  | 0.157 | 0.154 |  |  |  | 60.3 KiB | 244 |
| core/lambdas | quickjs |  | 0.124 | 0.118 |  |  |  |  |  |
| core/lambdas | starlark-go |  | 0.235 | 0.233 |  |  |  | 156.6 KiB | 2010 |
| core/lambdas | ts-native |  | 0.00209 | 0.00206 |  |  |  | 5 B |  |
| core/lambdas | wasmoon |  | 0.0575 | 0.0555 |  |  |  |  |  |
| core/loop | go | 71.1 | 41.652 | 41.066 | 48016 | 867.5 | 62.5 KiB | 83.5 MiB | 765271 |
| core/loop | ts | 293.9 | 25.519 | 24.061 | 48016 | 531.5 | 62.5 KiB | 443.4 KiB |  |
| core/loop | cpython |  | 0.0372 | 0.0367 |  |  |  | 0 B |  |
| core/loop | go-native |  | 0.000683 | 0.000681 |  |  |  | 8 B | 1 |
| core/loop | gopher-lua |  | 0.0450 | 0.0442 |  |  |  | 44.8 KiB | 180 |
| core/loop | quickjs |  | 0.0699 | 0.0653 |  |  |  |  |  |
| core/loop | starlark-go |  | 0.0741 | 0.0738 |  |  |  | 256 B | 6 |
| core/loop | ts-native |  | 0.000951 | 0.000934 |  |  |  | 1 B |  |
| core/loop | wasmoon |  | 0.0122 | 0.0121 |  |  |  |  |  |
| host/conversion | go | 97.4 | 22.779 | 22.460 | 25018 | 910.5 | 220.3 KiB | 41.1 MiB | 357828 |
| host/conversion | ts | 481.1 | 18.803 | 17.667 | 25018 | 751.6 | 220.3 KiB | 219.1 KiB |  |
| host/immediate | go | 74.8 | 10.323 | 10.173 | 13518 | 763.6 | 15.7 KiB | 18.5 MiB | 197938 |
| host/immediate | ts | 313.4 | 6.910 | 6.223 | 13518 | 511.2 | 15.7 KiB | 328 B |  |
| host/properties | go | 67.8 | 8.644 | 8.570 | 9018 | 958.6 | 15.7 KiB | 15.2 MiB | 176565 |
| host/properties | ts | 275.7 | 6.154 | 5.682 | 9018 | 682.4 | 15.7 KiB | 103.9 KiB |  |
| host/pump | go | 22.6 | 0.00579 | 0.00563 | 7 | 827.4 | 0 B | 11.1 KiB | 60 |
| host/pump | ts | 56.3 | 0.0110 | 0.0102 | 7 | 1571.6 | 0 B | 3.4 KiB |  |
| host/suspending | go | 74.2 | 13.784 | 13.683 | 13518 | 1019.7 | 15.7 KiB | 21.9 MiB | 263176 |
| host/suspending | ts | 317.9 | 11.701 | 10.848 | 13518 | 865.6 | 15.7 KiB | 11.1 KiB |  |
| macro/game-tick | go | 137.4 | 39.699 | 39.228 | 67042 | 592.1 | 78.4 KiB | 80.1 MiB | 638022 |
| macro/game-tick | ts | 619.3 | 26.426 | 24.836 | 67042 | 394.2 | 78.4 KiB | 3.6 KiB |  |
| macro/game-tick | cpython |  | 0.0967 | 0.0960 |  |  |  | 0 B |  |
| macro/game-tick | go-native |  | 0.000345 | 0.000342 |  |  |  | 8 B | 1 |
| macro/game-tick | gopher-lua |  | 0.225 | 0.224 |  |  |  | 28.7 KiB | 128 |
| macro/game-tick | quickjs |  | 0.0847 | 0.0824 |  |  |  |  |  |
| macro/game-tick | starlark-go |  | 0.256 | 0.254 |  |  |  | 94.5 KiB | 1007 |
| macro/game-tick | ts-native |  | 0.000685 | 0.000671 |  |  |  | 0 B |  |
| macro/game-tick | wasmoon |  | 0.0522 | 0.0499 |  |  |  |  |  |
| macro/report | go | 90.3 | 6.538 | 6.495 | 86555 | 75.5 | 1.2 MiB | 11.9 MiB | 91000 |
| macro/report | ts | 350.1 | 26.035 | 24.754 | 86555 | 300.8 | 1.2 MiB | 4.9 MiB |  |
| macro/report | cpython |  | 0.0351 | 0.0349 |  |  |  | 14.8 KiB |  |
| macro/report | go-native |  | 0.0158 | 0.0158 |  |  |  | 8.8 KiB | 85 |
| macro/report | gopher-lua |  | 0.200 | 0.199 |  |  |  | 33.0 KiB | 1290 |
| macro/report | quickjs |  | 0.0645 | 0.0617 |  |  |  |  |  |
| macro/report | starlark-go |  | 0.0980 | 0.0967 |  |  |  | 66.2 KiB | 3084 |
| macro/report | ts-native |  | 0.00424 | 0.00414 |  |  |  | 12 B |  |
| macro/report | wasmoon |  | 0.0699 | 0.0599 |  |  |  |  |  |
| macro/transform | go | 118.1 | 63.882 | 63.180 | 20664 | 3091.5 | 6.1 MiB | 121.3 MiB | 1099024 |
| macro/transform | ts | 491.5 | 24.046 | 22.850 | 20664 | 1163.7 | 6.1 MiB | 177.1 KiB |  |
| macro/transform | cpython |  | 0.0314 | 0.0313 |  |  |  | 48.0 KiB |  |
| macro/transform | go-native |  | 0.00117 | 0.00115 |  |  |  | 7.4 KiB | 3 |
| macro/transform | gopher-lua |  | 0.207 | 0.206 |  |  |  | 268.0 KiB | 4538 |
| macro/transform | quickjs |  | 0.0773 | 0.0754 |  |  |  |  |  |
| macro/transform | starlark-go |  | 0.0927 | 0.0919 |  |  |  | 168.7 KiB | 328 |
| macro/transform | ts-native |  | 0.00378 | 0.00370 |  |  |  | 1 B |  |
| macro/transform | wasmoon |  | 0.0499 | 0.0390 |  |  |  |  |  |
| numbers/add | go | 73.4 | 29.826 | 29.453 | 26030 | 1145.8 | 31.4 KiB | 57.8 MiB | 623408 |
| numbers/add | ts | 295.6 | 16.744 | 15.660 | 26030 | 643.3 | 31.4 KiB | 310.1 KiB |  |
| numbers/add | cpython |  | 0.0355 | 0.0353 |  |  |  | 0 B |  |
| numbers/add | go-native |  | 0.00186 | 0.00185 |  |  |  | 8 B | 1 |
| numbers/add | gopher-lua |  | 0.0476 | 0.0470 |  |  |  | 43.9 KiB | 177 |
| numbers/add | quickjs |  | 0.0690 | 0.0650 |  |  |  |  |  |
| numbers/add | starlark-go |  | 0.0828 | 0.0825 |  |  |  | 15.9 KiB | 2010 |
| numbers/add | ts-native |  | 0.00186 | 0.00183 |  |  |  | 0 B |  |
| numbers/add | wasmoon |  | 0.0136 | 0.0136 |  |  |  |  |  |
| numbers/divide | go | 76.4 | 21.584 | 20.226 | 18031 | 1197.0 | 31.4 KiB | 38.0 MiB | 448324 |
| numbers/divide | ts | 300.5 | 15.238 | 14.247 | 18031 | 845.1 | 31.4 KiB | 240.7 KiB |  |
| numbers/divide | cpython |  | 0.0285 | 0.0281 |  |  |  | 0 B |  |
| numbers/divide | go-native |  | 0.00121 | 0.00120 |  |  |  | 8 B | 1 |
| numbers/divide | gopher-lua |  | 0.0345 | 0.0342 |  |  |  | 28.3 KiB | 115 |
| numbers/divide | quickjs |  | 0.0443 | 0.0439 |  |  |  |  |  |
| numbers/divide | starlark-go |  | 0.0692 | 0.0691 |  |  |  | 15.9 KiB | 2010 |
| numbers/divide | ts-native |  | 0.000919 | 0.000900 |  |  |  | 0 B |  |
| numbers/divide | wasmoon |  | 0.0116 | 0.0116 |  |  |  |  |  |
| numbers/multiply | go | 77.6 | 20.361 | 20.190 | 18031 | 1129.2 | 31.4 KiB | 38.0 MiB | 444830 |
| numbers/multiply | ts | 296.2 | 15.896 | 14.567 | 18031 | 881.6 | 31.4 KiB | 382.8 KiB |  |
| numbers/multiply | cpython |  | 0.0308 | 0.0293 |  |  |  | 0 B |  |
| numbers/multiply | go-native |  | 0.00121 | 0.00120 |  |  |  | 8 B | 1 |
| numbers/multiply | gopher-lua |  | 0.0322 | 0.0317 |  |  |  | 29.1 KiB | 118 |
| numbers/multiply | quickjs |  | 0.0428 | 0.0425 |  |  |  |  |  |
| numbers/multiply | starlark-go |  | 0.0674 | 0.0666 |  |  |  | 15.9 KiB | 2010 |
| numbers/multiply | ts-native |  | 0.000922 | 0.000895 |  |  |  | 0 B |  |
| numbers/multiply | wasmoon |  | 0.0132 | 0.0132 |  |  |  |  |  |
| numbers/quantity | go | 94.4 | 22.291 | 22.082 | 14579 | 1529.0 | 39.1 KiB | 35.6 MiB | 549835 |
| numbers/quantity | ts | 368.0 | 25.887 | 24.474 | 14579 | 1775.6 | 39.1 KiB | 1.1 MiB |  |
| numbers/quantity | cpython |  | 0.0189 | 0.0188 |  |  |  | 0 B |  |
| numbers/quantity | go-native |  | 0.000454 | 0.000452 |  |  |  | 8 B | 1 |
| numbers/quantity | gopher-lua |  | 0.0200 | 0.0198 |  |  |  | 16.5 KiB | 67 |
| numbers/quantity | quickjs |  | 0.0228 | 0.0226 |  |  |  |  |  |
| numbers/quantity | starlark-go |  | 0.0450 | 0.0448 |  |  |  | 8.1 KiB | 1009 |
| numbers/quantity | ts-native |  | 0.000552 | 0.000545 |  |  |  | 0 B |  |
| numbers/quantity | wasmoon |  | 0.00877 | 0.00862 |  |  |  |  |  |
| text/build | go | 67.9 | 5.404 | 5.327 | 28928 | 186.8 | 374.8 KiB | 10.2 MiB | 93990 |
| text/build | ts | 237.7 | 8.521 | 7.977 | 28928 | 294.6 | 374.8 KiB | 99.2 KiB |  |
| text/build | cpython |  | 0.0187 | 0.0186 |  |  |  | 1.5 KiB |  |
| text/build | go-native |  | 0.0624 | 0.0607 |  |  |  | 387.1 KiB | 500 |
| text/build | gopher-lua |  | 0.0973 | 0.0960 |  |  |  | 400.8 KiB | 1024 |
| text/build | quickjs |  | 0.0379 | 0.0376 |  |  |  |  |  |
| text/build | starlark-go |  | 0.0938 | 0.0923 |  |  |  | 395.1 KiB | 1006 |
| text/build | ts-native |  | 0.00160 | 0.00151 |  |  |  | 34 B |  |
| text/build | wasmoon |  | 0.0655 | 0.0623 |  |  |  |  |  |
| text/graphemes | go | 81.9 | 37.082 | 36.533 | 43518 | 852.1 | 144.1 KiB | 87.2 MiB | 567064 |
| text/graphemes | ts | 341.7 | 25.839 | 23.252 | 43518 | 593.8 | 144.1 KiB | 924.6 KiB |  |
| text/index | go | 85.9 | 27.304 | 27.081 | 26640 | 1024.9 | 49.9 KiB | 49.9 MiB | 547275 |
| text/index | ts | 371.2 | 24.456 | 23.190 | 26640 | 918.0 | 49.9 KiB | 1.2 MiB |  |
| text/index | cpython |  | 0.0319 | 0.0317 |  |  |  | 0 B |  |
| text/index | go-native |  | 0.000831 | 0.000823 |  |  |  | 0 B | 0 |
| text/index | gopher-lua |  | 0.181 | 0.180 |  |  |  | 29.3 KiB | 1055 |
| text/index | quickjs |  | 0.0798 | 0.0777 |  |  |  |  |  |
| text/index | starlark-go |  | 0.0888 | 0.0885 |  |  |  | 15.9 KiB | 1006 |
| text/index | ts-native |  | 0.00120 | 0.00118 |  |  |  | 0 B |  |
| text/index | wasmoon |  | 0.0560 | 0.0542 |  |  |  |  |  |
| text/iterate | go | 78.0 | 25.265 | 24.877 | 30318 | 833.3 | 93.0 KiB | 62.2 MiB | 383563 |
| text/iterate | ts | 296.7 | 14.954 | 14.201 | 30318 | 493.2 | 93.0 KiB | 195.8 KiB |  |
| text/iterate | cpython |  | 0.0360 | 0.0359 |  |  |  | 48 B |  |
| text/iterate | go-native |  | 0.000820 | 0.000818 |  |  |  | 8 B | 1 |
| text/iterate | gopher-lua |  | 0.286 | 0.283 |  |  |  | 187.3 KiB | 9847 |
| text/iterate | quickjs |  | 0.0981 | 0.0958 |  |  |  |  |  |
| text/iterate | starlark-go |  | 0.179 | 0.178 |  |  |  | 62.0 KiB | 3607 |
| text/iterate | ts-native |  | 0.00178 | 0.00174 |  |  |  | 0 B |  |
| text/iterate | wasmoon |  | 0.0771 | 0.0719 |  |  |  |  |  |
| text/patterns | go | 79.9 | 13.389 | 13.216 | 13818 | 969.0 | 225.9 KiB | 22.1 MiB | 202205 |
| text/patterns | ts | 352.5 | 10.613 | 9.997 | 13818 | 768.0 | 225.9 KiB | 302.3 KiB |  |
| text/patterns | cpython |  | 0.0930 | 0.0926 |  |  |  | 1.2 KiB |  |
| text/patterns | go-native |  | 0.107 | 0.106 |  |  |  | 37.7 KiB | 1201 |
| text/patterns | gopher-lua |  | 0.424 | 0.424 |  |  |  | 390.8 KiB | 17736 |
| text/patterns | quickjs |  | 0.339 | 0.331 |  |  |  |  |  |
| text/patterns | starlark-go |  | 0.316 | 0.315 |  |  |  | 87.0 KiB | 4507 |
| text/patterns | ts-native |  | 0.0251 | 0.0236 |  |  |  | 76 B |  |
| text/patterns | wasmoon |  | 0.100 | 0.0952 |  |  |  |  |  |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- collections/map-build on ts: 2009.4 ns/Fuel, 3.2× the median
- macro/transform on go: 3091.5 ns/Fuel, 3.2× the median

## Skipped

- text/graphemes on peers: Unicode grapheme segmentation has no shared API across the pinned peers; text/iterate and text/index compare ASCII.
- host/immediate on peers: NorthTalk embedding API; no peer counterpart.
- host/suspending on peers: NorthTalk embedding API; no peer counterpart.
- host/properties on peers: NorthTalk embedding API; no peer counterpart.
- host/conversion on peers: NorthTalk embedding API; no peer counterpart.
- host/pump on peers: NorthTalk embedding API; no peer counterpart.
