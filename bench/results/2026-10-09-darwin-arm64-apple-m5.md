# Benchmark results, 2026-10-09

Commit `e369663` on Apple M5 (10 cores, 24 GiB), darwin arm64.
Versions: bun 1.4.2, cost model 0, go go1.27.2, language 1.0-rc.2, applescript 2.8 (macOS 27.0.1), cpython 3.14.8, gopher-lua v1.1.2, quickjs-emscripten 0.32.0, starlark-go v0.0.0-20261005163335-bcb1a1a55bf9, wasmoon 1.16.0.
Settings: count 10, runners go,ts,peers, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | go | 89.1 | 16.531 | 16.488 | 89459 | 184.8 | 195.6 KiB | 9.4 MiB | 133928 |
| collections/iterate | ts | 257.1 | 25.510 | 24.057 | 89459 | 285.2 | 195.6 KiB | 3.0 KiB |  |
| collections/iterate | applescript |  | 6.036 | 6.014 |  |  |  |  |  |
| collections/iterate | cpython |  | 0.0543 | 0.0541 |  |  |  | 2.5 KiB |  |
| collections/iterate | go-native |  | 0.0171 | 0.0171 |  |  |  | 1.8 KiB | 4 |
| collections/iterate | gopher-lua |  | 0.390 | 0.388 |  |  |  | 108.8 KiB | 6741 |
| collections/iterate | quickjs |  | 0.129 | 0.125 |  |  |  |  |  |
| collections/iterate | starlark-go |  | 0.175 | 0.175 |  |  |  | 270.5 KiB | 783 |
| collections/iterate | ts-native |  | 0.00749 | 0.00735 |  |  |  | 2 B |  |
| collections/iterate | wasmoon |  | 0.118 | 0.114 |  |  |  |  |  |
| collections/list-append | go | 70.8 | 9.115 | 9.099 | 52056 | 175.1 | 78.3 KiB | 6.9 MiB | 80132 |
| collections/list-append | ts | 196.7 | 14.087 | 12.416 | 52056 | 270.6 | 78.3 KiB | 1.5 MiB |  |
| collections/list-append | applescript |  | 1.402 | 1.397 |  |  |  |  |  |
| collections/list-append | cpython |  | 0.0374 | 0.0363 |  |  |  | 67.2 KiB |  |
| collections/list-append | go-native |  | 0.00181 | 0.00180 |  |  |  | 16.0 KiB | 2 |
| collections/list-append | gopher-lua |  | 0.176 | 0.175 |  |  |  | 203.9 KiB | 4315 |
| collections/list-append | quickjs |  | 0.0902 | 0.0851 |  |  |  |  |  |
| collections/list-append | starlark-go |  | 0.166 | 0.162 |  |  |  | 223.8 KiB | 4027 |
| collections/list-append | ts-native |  | 0.00395 | 0.00387 |  |  |  | 5 B |  |
| collections/list-append | wasmoon |  | 0.0446 | 0.0426 |  |  |  |  |  |
| collections/list-build | go | 47.7 | 2.142 | 2.138 | 19091 | 112.2 | 2.9 MiB | 1.7 MiB | 20060 |
| collections/list-build | ts | 120.6 | 3.088 | 2.707 | 19091 | 161.8 | 2.9 MiB | 261.3 KiB |  |
| collections/list-build | applescript |  | 0.228 | 0.227 |  |  |  |  |  |
| collections/list-build | cpython |  | 0.00740 | 0.00737 |  |  |  | 8.6 KiB |  |
| collections/list-build | go-native |  | 0.000547 | 0.000545 |  |  |  | 4.0 KiB | 2 |
| collections/list-build | gopher-lua |  | 0.0370 | 0.0368 |  |  |  | 35.4 KiB | 1045 |
| collections/list-build | quickjs |  | 0.0234 | 0.0233 |  |  |  |  |  |
| collections/list-build | starlark-go |  | 0.0175 | 0.0175 |  |  |  | 18.7 KiB | 18 |
| collections/list-build | ts-native |  | 0.000809 | 0.000789 |  |  |  | 0 B |  |
| collections/list-build | wasmoon |  | 0.0110 | 0.00988 |  |  |  |  |  |
| collections/list-update | go | 68.2 | 6.776 | 6.759 | 28553 | 237.3 | 23.8 KiB | 14.4 MiB | 79612 |
| collections/list-update | ts | 200.3 | 3.936 | 3.383 | 28553 | 137.8 | 23.8 KiB | 2.1 KiB |  |
| collections/list-update | applescript |  | 0.381 | 0.368 |  |  |  |  |  |
| collections/list-update | cpython |  | 0.00931 | 0.00926 |  |  |  | 184 B |  |
| collections/list-update | go-native |  | 0.000368 | 0.000365 |  |  |  | 72 B | 2 |
| collections/list-update | gopher-lua |  | 0.0256 | 0.0255 |  |  |  | 22.4 KiB | 106 |
| collections/list-update | quickjs |  | 0.0175 | 0.0175 |  |  |  |  |  |
| collections/list-update | starlark-go |  | 0.0306 | 0.0305 |  |  |  | 704 B | 13 |
| collections/list-update | ts-native |  | 0.00107 | 0.000726 |  |  |  | 0 B |  |
| collections/list-update | wasmoon |  | 0.00594 | 0.00586 |  |  |  |  |  |
| collections/map-build | go | 60.8 | 7.073 | 7.040 | 14094 | 501.8 | 24.3 KiB | 35.5 MiB | 20499 |
| collections/map-build | ts | 156.3 | 18.196 | 17.537 | 14094 | 1291.0 | 24.3 KiB | 10.4 MiB |  |
| collections/map-build | applescript |  | 5.810 | 5.771 |  |  |  |  |  |
| collections/map-build | cpython |  | 0.0153 | 0.0152 |  |  |  | 19.3 KiB |  |
| collections/map-build | go-native |  | 0.00562 | 0.00556 |  |  |  | 13.9 KiB | 205 |
| collections/map-build | gopher-lua |  | 0.0790 | 0.0787 |  |  |  | 90.5 KiB | 1291 |
| collections/map-build | quickjs |  | 0.0306 | 0.0305 |  |  |  |  |  |
| collections/map-build | starlark-go |  | 0.0378 | 0.0377 |  |  |  | 99.4 KiB | 827 |
| collections/map-build | ts-native |  | 0.00359 | 0.00351 |  |  |  | 11 B |  |
| collections/map-build | wasmoon |  | 0.0415 | 0.0396 |  |  |  |  |  |
| collections/map-update | go | 79.4 | 1.657 | 1.655 | 8056 | 205.7 | 12.1 KiB | 3.0 MiB | 11073 |
| collections/map-update | ts | 177.9 | 2.693 | 2.585 | 8056 | 334.2 | 12.1 KiB | 8.0 KiB |  |
| collections/map-update | applescript |  | 3.528 | 3.489 |  |  |  |  |  |
| collections/map-update | cpython |  | 0.00411 | 0.00410 |  |  |  | 480 B |  |
| collections/map-update | go-native |  | 0.00273 | 0.00272 |  |  |  | 520 B | 5 |
| collections/map-update | gopher-lua |  | 0.0187 | 0.0186 |  |  |  | 10.2 KiB | 76 |
| collections/map-update | quickjs |  | 0.0188 | 0.0184 |  |  |  |  |  |
| collections/map-update | starlark-go |  | 0.0133 | 0.0132 |  |  |  | 1.7 KiB | 11 |
| collections/map-update | ts-native |  | 0.00142 | 0.00139 |  |  |  | 0 B |  |
| collections/map-update | wasmoon |  | 0.00337 | 0.00308 |  |  |  |  |  |
| core/calls | go | 52.7 | 5.484 | 5.466 | 46018 | 119.2 | 31.3 KiB | 4.1 MiB | 54021 |
| core/calls | ts | 138.3 | 10.348 | 9.404 | 46018 | 224.9 | 31.3 KiB | 301.2 KiB |  |
| core/calls | applescript |  | 0.595 | 0.593 |  |  |  |  |  |
| core/calls | cpython |  | 0.0314 | 0.0312 |  |  |  | 0 B |  |
| core/calls | go-native |  | 0.000454 | 0.000453 |  |  |  | 8 B | 1 |
| core/calls | gopher-lua |  | 0.0717 | 0.0714 |  |  |  | 44.8 KiB | 180 |
| core/calls | quickjs |  | 0.0482 | 0.0479 |  |  |  |  |  |
| core/calls | starlark-go |  | 0.110 | 0.110 |  |  |  | 125.3 KiB | 2006 |
| core/calls | ts-native |  | 0.000560 | 0.000507 |  |  |  | 0 B |  |
| core/calls | wasmoon |  | 0.0231 | 0.0227 |  |  |  |  |  |
| core/fib | go | 51.6 | 4.985 | 4.972 | 46365 | 107.5 | 46.2 KiB | 2.9 MiB | 57093 |
| core/fib | ts | 142.2 | 9.821 | 9.207 | 46365 | 211.8 | 46.2 KiB | 708.5 KiB |  |
| core/fib | applescript |  | 0.469 | 0.468 |  |  |  |  |  |
| core/fib | cpython |  | 0.0250 | 0.0248 |  |  |  | 0 B |  |
| core/fib | go-native |  | 0.00127 | 0.00126 |  |  |  | 8 B | 1 |
| core/fib | gopher-lua |  | 0.0723 | 0.0692 |  |  |  | 63 B | 1 |
| core/fib | quickjs |  | 0.0412 | 0.0408 |  |  |  |  |  |
| core/fib | starlark-go |  | 0.141 | 0.140 |  |  |  | 154.2 KiB | 1975 |
| core/fib | ts-native |  | 0.00188 | 0.00187 |  |  |  | 0 B |  |
| core/fib | wasmoon |  | 0.0277 | 0.0275 |  |  |  |  |  |
| core/fib@slice=10 | go | 51.4 | 10.016 | 9.988 | 46365 | 216.0 | 46.2 KiB | 17.8 MiB | 184206 |
| core/fib@slice=10 | ts | 102.3 | 19.898 | 18.103 | 46365 | 429.2 | 46.2 KiB | 581.3 KiB |  |
| core/fib@slice=100 | go | 51.7 | 5.870 | 5.844 | 46365 | 126.6 | 46.2 KiB | 6.3 MiB | 74029 |
| core/fib@slice=100 | ts | 85.7 | 11.722 | 10.740 | 46365 | 252.8 | 46.2 KiB | 33.6 KiB |  |
| core/fib@slice=1000 | go | 51.1 | 5.130 | 5.117 | 46365 | 110.6 | 46.2 KiB | 3.4 MiB | 59160 |
| core/fib@slice=1000 | ts | 84.3 | 10.146 | 9.627 | 46365 | 218.8 | 46.2 KiB | 223.1 KiB |  |
| core/fib@slice=10000 | go | 51.7 | 5.011 | 4.988 | 46365 | 108.1 | 46.2 KiB | 3.0 MiB | 57289 |
| core/fib@slice=10000 | ts | 83.7 | 9.805 | 9.317 | 46365 | 211.5 | 46.2 KiB | 21.2 KiB |  |
| core/lambdas | go | 59.0 | 7.856 | 7.831 | 58027 | 135.4 | 62.6 KiB | 6.4 MiB | 84014 |
| core/lambdas | ts | 173.4 | 16.158 | 15.466 | 58027 | 278.5 | 62.6 KiB | 1.3 MiB |  |
| core/lambdas | applescript |  | 0.643 | 0.642 |  |  |  |  |  |
| core/lambdas | cpython |  | 0.0479 | 0.0416 |  |  |  | 208 B |  |
| core/lambdas | go-native |  | 0.000469 | 0.000467 |  |  |  | 8 B | 1 |
| core/lambdas | gopher-lua |  | 0.0871 | 0.0865 |  |  |  | 60.3 KiB | 244 |
| core/lambdas | quickjs |  | 0.0514 | 0.0511 |  |  |  |  |  |
| core/lambdas | starlark-go |  | 0.135 | 0.134 |  |  |  | 156.6 KiB | 2010 |
| core/lambdas | ts-native |  | 0.000948 | 0.000933 |  |  |  | 2 B |  |
| core/lambdas | wasmoon |  | 0.0290 | 0.0269 |  |  |  |  |  |
| core/loop | go | 44.1 | 7.666 | 7.646 | 48016 | 159.7 | 62.5 KiB | 1.9 MiB | 79975 |
| core/loop | ts | 106.5 | 15.508 | 14.373 | 48016 | 323.0 | 62.5 KiB | 1.0 MiB |  |
| core/loop | applescript |  | 0.178 | 0.177 |  |  |  |  |  |
| core/loop | cpython |  | 0.0182 | 0.0182 |  |  |  | 0 B |  |
| core/loop | go-native |  | 0.000471 | 0.000466 |  |  |  | 8 B | 1 |
| core/loop | gopher-lua |  | 0.0257 | 0.0256 |  |  |  | 44.8 KiB | 180 |
| core/loop | quickjs |  | 0.0192 | 0.0181 |  |  |  |  |  |
| core/loop | starlark-go |  | 0.0400 | 0.0393 |  |  |  | 256 B | 6 |
| core/loop | ts-native |  | 0.000540 | 0.000507 |  |  |  | 1 B |  |
| core/loop | wasmoon |  | 0.00707 | 0.00701 |  |  |  |  |  |
| host/conversion | go | 60.9 | 6.756 | 6.738 | 25018 | 270.0 | 220.3 KiB | 14.0 MiB | 117651 |
| host/conversion | ts | 187.0 | 10.201 | 9.588 | 25018 | 407.7 | 220.3 KiB | 1.0 MiB |  |
| host/immediate | go | 46.0 | 2.108 | 2.102 | 13518 | 155.9 | 15.7 KiB | 1.8 MiB | 29743 |
| host/immediate | ts | 126.3 | 3.500 | 3.159 | 13518 | 258.9 | 15.7 KiB | 26.8 KiB |  |
| host/properties | go | 42.1 | 1.596 | 1.583 | 9018 | 176.9 | 15.7 KiB | 949.6 KiB | 18423 |
| host/properties | ts | 113.0 | 3.506 | 3.201 | 9018 | 388.8 | 15.7 KiB | 683.7 KiB |  |
| host/pump | go | 13.5 | 0.00394 | 0.00393 | 7 | 562.4 | 0 B | 12.7 KiB | 71 |
| host/pump | ts | 22.4 | 0.00606 | 0.00560 | 7 | 865.9 | 0 B | 2.1 KiB |  |
| host/suspending | go | 45.8 | 4.066 | 4.056 | 13518 | 300.8 | 15.7 KiB | 6.5 MiB | 72981 |
| host/suspending | ts | 127.9 | 6.365 | 5.756 | 13518 | 470.8 | 15.7 KiB | 371.2 KiB |  |
| lifecycle/load-large | go | 4338.1 | 0.758 | 0.750 | 4609 | 164.5 | 16.3 KiB | 479.4 KiB | 7395 |
| lifecycle/load-large | ts | 14700.8 | 1.272 | 1.180 | 4609 | 275.9 | 16.3 KiB | 129.9 KiB |  |
| lifecycle/load-small | go | 17.4 | 0.00404 | 0.00403 | 7 | 577.4 | 0 B | 12.7 KiB | 74 |
| lifecycle/load-small | ts | 34.3 | 0.00690 | 0.00642 | 7 | 985.5 | 0 B | 1.1 KiB |  |
| lifecycle/restore | go | 87.4 | 48.855 | 48.497 | 8015 | 6095.5 | 7.8 KiB | 62.9 MiB | 575568 |
| lifecycle/restore | ts | 247.7 | 11.773 | 11.202 | 8015 | 1468.9 | 7.8 KiB | 30.9 KiB |  |
| lifecycle/rollback | go | 93.8 | 23.721 | 23.659 | 102023 | 232.5 | 39.9 KiB | 55.3 MiB | 357777 |
| lifecycle/rollback | ts | 260.7 | 68.880 | 59.290 | 102023 | 675.1 | 39.9 KiB | 9.3 KiB |  |
| macro/game-tick | go | 86.6 | 8.644 | 8.636 | 67042 | 128.9 | 78.4 KiB | 8.3 MiB | 81912 |
| macro/game-tick | ts | 230.7 | 18.600 | 17.616 | 67042 | 277.4 | 78.4 KiB | 2.5 KiB |  |
| macro/game-tick | applescript |  | 1.377 | 1.371 |  |  |  |  |  |
| macro/game-tick | cpython |  | 0.0495 | 0.0490 |  |  |  | 0 B |  |
| macro/game-tick | go-native |  | 0.000236 | 0.000235 |  |  |  | 8 B | 1 |
| macro/game-tick | gopher-lua |  | 0.128 | 0.126 |  |  |  | 28.7 KiB | 128 |
| macro/game-tick | quickjs |  | 0.0431 | 0.0426 |  |  |  |  |  |
| macro/game-tick | starlark-go |  | 0.150 | 0.149 |  |  |  | 94.5 KiB | 1007 |
| macro/game-tick | ts-native |  | 0.000334 | 0.000328 |  |  |  | 0 B |  |
| macro/game-tick | wasmoon |  | 0.0230 | 0.0215 |  |  |  |  |  |
| macro/report | go | 55.4 | 1.825 | 1.823 | 86555 | 21.1 | 1.2 MiB | 1.8 MiB | 16386 |
| macro/report | ts | 124.7 | 16.309 | 15.524 | 86555 | 188.4 | 1.2 MiB | 10.8 MiB |  |
| macro/report | applescript |  | 3.121 | 3.055 |  |  |  |  |  |
| macro/report | cpython |  | 0.0199 | 0.0196 |  |  |  | 14.8 KiB |  |
| macro/report | go-native |  | 0.00935 | 0.00931 |  |  |  | 8.8 KiB | 85 |
| macro/report | gopher-lua |  | 0.139 | 0.125 |  |  |  | 33.0 KiB | 1290 |
| macro/report | quickjs |  | 0.0397 | 0.0393 |  |  |  |  |  |
| macro/report | starlark-go |  | 0.0579 | 0.0578 |  |  |  | 66.2 KiB | 3084 |
| macro/report | ts-native |  | 0.00283 | 0.00277 |  |  |  | 4 B |  |
| macro/report | wasmoon |  | 0.0407 | 0.0343 |  |  |  |  |  |
| macro/transform | go | 73.9 | 2.794 | 2.791 | 20664 | 135.2 | 6.1 MiB | 2.4 MiB | 27948 |
| macro/transform | ts | 173.4 | 4.493 | 4.146 | 20664 | 217.4 | 6.1 MiB | 1.1 MiB |  |
| macro/transform | applescript |  | 0.339 | 0.338 |  |  |  |  |  |
| macro/transform | cpython |  | 0.0184 | 0.0184 |  |  |  | 48.0 KiB |  |
| macro/transform | go-native |  | 0.000695 | 0.000693 |  |  |  | 7.4 KiB | 3 |
| macro/transform | gopher-lua |  | 0.120 | 0.120 |  |  |  | 268.0 KiB | 4538 |
| macro/transform | quickjs |  | 0.0515 | 0.0512 |  |  |  |  |  |
| macro/transform | starlark-go |  | 0.0528 | 0.0525 |  |  |  | 168.7 KiB | 328 |
| macro/transform | ts-native |  | 0.00244 | 0.00240 |  |  |  | 0 B |  |
| macro/transform | wasmoon |  | 0.0326 | 0.0257 |  |  |  |  |  |
| messaging/joins | go | 80.5 | 24.083 | 24.040 | 127218 | 189.3 | 239.1 KiB | 49.2 MiB | 349735 |
| messaging/joins | ts | 237.3 | 34.436 | 31.037 | 127218 | 270.7 | 239.1 KiB | 2.3 KiB |  |
| messaging/parents | go | 53.3 | 16.312 | 16.240 | 67518 | 241.6 | 93.8 KiB | 30.8 MiB | 280294 |
| messaging/parents | ts | 161.1 | 23.796 | 23.104 | 67518 | 352.4 | 93.8 KiB | 0 B |  |
| messaging/sends | go | 62.7 | 14.460 | 14.424 | 67518 | 214.2 | 93.8 KiB | 32.5 MiB | 241295 |
| messaging/sends | ts | 184.2 | 21.735 | 19.120 | 67518 | 321.9 | 93.8 KiB | 188.5 KiB |  |
| messaging/suspend | go | 42.0 | 15.079 | 15.060 | 48018 | 314.0 | 31.3 KiB | 20.2 MiB | 384051 |
| messaging/suspend | ts | 104.8 | 24.965 | 24.029 | 48018 | 519.9 | 31.3 KiB | 2.7 MiB |  |
| numbers/add | go | 45.5 | 4.399 | 4.387 | 26030 | 169.0 | 31.4 KiB | 1.8 MiB | 46098 |
| numbers/add | ts | 121.8 | 9.580 | 9.129 | 26030 | 368.0 | 31.4 KiB | 1.0 MiB |  |
| numbers/add | applescript |  | 0.229 | 0.226 |  |  |  |  |  |
| numbers/add | cpython |  | 0.0200 | 0.0194 |  |  |  | 0 B |  |
| numbers/add | go-native |  | 0.00108 | 0.00108 |  |  |  | 8 B | 1 |
| numbers/add | gopher-lua |  | 0.0261 | 0.0260 |  |  |  | 43.9 KiB | 177 |
| numbers/add | quickjs |  | 0.0195 | 0.0193 |  |  |  |  |  |
| numbers/add | starlark-go |  | 0.0454 | 0.0449 |  |  |  | 15.9 KiB | 2010 |
| numbers/add | ts-native |  | 0.000988 | 0.000978 |  |  |  | 0 B |  |
| numbers/add | wasmoon |  | 0.00745 | 0.00741 |  |  |  |  |  |
| numbers/divide | go | 46.9 | 4.605 | 4.582 | 18031 | 255.4 | 31.4 KiB | 4.0 MiB | 145728 |
| numbers/divide | ts | 92.0 | 8.132 | 7.699 | 18031 | 451.0 | 31.4 KiB | 1012.0 KiB |  |
| numbers/divide | applescript |  | 0.190 | 0.190 |  |  |  |  |  |
| numbers/divide | cpython |  | 0.0156 | 0.0153 |  |  |  | 0 B |  |
| numbers/divide | go-native |  | 0.000699 | 0.000699 |  |  |  | 8 B | 1 |
| numbers/divide | gopher-lua |  | 0.0197 | 0.0196 |  |  |  | 28.3 KiB | 115 |
| numbers/divide | quickjs |  | 0.0145 | 0.0145 |  |  |  |  |  |
| numbers/divide | starlark-go |  | 0.0383 | 0.0379 |  |  |  | 15.9 KiB | 2010 |
| numbers/divide | ts-native |  | 0.000542 | 0.000517 |  |  |  | 1 B |  |
| numbers/divide | wasmoon |  | 0.00583 | 0.00559 |  |  |  |  |  |
| numbers/multiply | go | 47.7 | 3.035 | 3.024 | 18031 | 168.3 | 31.4 KiB | 1.2 MiB | 37090 |
| numbers/multiply | ts | 95.3 | 8.132 | 7.688 | 18031 | 451.0 | 31.4 KiB | 705.7 KiB |  |
| numbers/multiply | applescript |  | 0.172 | 0.171 |  |  |  |  |  |
| numbers/multiply | cpython |  | 0.0155 | 0.0154 |  |  |  | 0 B |  |
| numbers/multiply | go-native |  | 0.000699 | 0.000698 |  |  |  | 8 B | 1 |
| numbers/multiply | gopher-lua |  | 0.0181 | 0.0180 |  |  |  | 29.1 KiB | 118 |
| numbers/multiply | quickjs |  | 0.0192 | 0.0191 |  |  |  |  |  |
| numbers/multiply | starlark-go |  | 0.0372 | 0.0370 |  |  |  | 15.9 KiB | 2010 |
| numbers/multiply | ts-native |  | 0.000542 | 0.000520 |  |  |  | 0 B |  |
| numbers/multiply | wasmoon |  | 0.00626 | 0.00605 |  |  |  |  |  |
| numbers/quantity | go | 58.1 | 5.913 | 5.896 | 14579 | 405.6 | 39.1 KiB | 5.4 MiB | 214418 |
| numbers/quantity | ts | 158.6 | 15.545 | 14.790 | 14579 | 1066.3 | 39.1 KiB | 2.0 MiB |  |
| numbers/quantity | applescript |  | 0.117 | 0.117 |  |  |  |  |  |
| numbers/quantity | cpython |  | 0.00965 | 0.00961 |  |  |  | 0 B |  |
| numbers/quantity | go-native |  | 0.000246 | 0.000245 |  |  |  | 8 B | 1 |
| numbers/quantity | gopher-lua |  | 0.0114 | 0.0113 |  |  |  | 16.5 KiB | 67 |
| numbers/quantity | quickjs |  | 0.00650 | 0.00641 |  |  |  |  |  |
| numbers/quantity | starlark-go |  | 0.0245 | 0.0244 |  |  |  | 8.1 KiB | 1009 |
| numbers/quantity | ts-native |  | 0.000313 | 0.000307 |  |  |  | 0 B |  |
| numbers/quantity | wasmoon |  | 0.00429 | 0.00392 |  |  |  |  |  |
| text/build | go | 42.1 | 1.081 | 1.079 | 28928 | 37.4 | 374.8 KiB | 853.6 KiB | 9050 |
| text/build | ts | 103.1 | 5.019 | 4.711 | 28928 | 173.5 | 374.8 KiB | 936.2 KiB |  |
| text/build | applescript |  | 0.363 | 0.360 |  |  |  |  |  |
| text/build | cpython |  | 0.0106 | 0.0100 |  |  |  | 1.5 KiB |  |
| text/build | go-native |  | 0.0374 | 0.0372 |  |  |  | 387.1 KiB | 500 |
| text/build | gopher-lua |  | 0.0553 | 0.0551 |  |  |  | 400.8 KiB | 1024 |
| text/build | quickjs |  | 0.0203 | 0.0202 |  |  |  |  |  |
| text/build | starlark-go |  | 0.0528 | 0.0525 |  |  |  | 395.1 KiB | 1006 |
| text/build | ts-native |  | 0.00120 | 0.00115 |  |  |  | 5 B |  |
| text/build | wasmoon |  | 0.0403 | 0.0389 |  |  |  |  |  |
| text/graphemes | go | 50.8 | 7.603 | 7.589 | 43518 | 174.7 | 144.1 KiB | 5.0 MiB | 84425 |
| text/graphemes | ts | 137.1 | 13.677 | 12.850 | 43518 | 314.3 | 144.1 KiB | 349.4 KiB |  |
| text/index | go | 53.1 | 6.829 | 6.815 | 26640 | 256.3 | 49.9 KiB | 6.2 MiB | 195187 |
| text/index | ts | 135.7 | 15.108 | 14.103 | 26640 | 567.1 | 49.9 KiB | 1.1 MiB |  |
| text/index | applescript |  | 0.875 | 0.869 |  |  |  |  |  |
| text/index | cpython |  | 0.0164 | 0.0164 |  |  |  | 0 B |  |
| text/index | go-native |  | 0.000394 | 0.000394 |  |  |  | 0 B | 0 |
| text/index | gopher-lua |  | 0.112 | 0.111 |  |  |  | 29.3 KiB | 1055 |
| text/index | quickjs |  | 0.0385 | 0.0372 |  |  |  |  |  |
| text/index | starlark-go |  | 0.0491 | 0.0479 |  |  |  | 15.9 KiB | 1006 |
| text/index | ts-native |  | 0.000640 | 0.000635 |  |  |  | 0 B |  |
| text/index | wasmoon |  | 0.0317 | 0.0304 |  |  |  |  |  |
| text/iterate | go | 49.0 | 4.988 | 4.980 | 30318 | 164.5 | 93.0 KiB | 3.6 MiB | 54824 |
| text/iterate | ts | 117.8 | 9.367 | 8.797 | 30318 | 309.0 | 93.0 KiB | 407.6 KiB |  |
| text/iterate | applescript |  | 3.322 | 3.267 |  |  |  |  |  |
| text/iterate | cpython |  | 0.0185 | 0.0185 |  |  |  | 48 B |  |
| text/iterate | go-native |  | 0.000478 | 0.000474 |  |  |  | 8 B | 1 |
| text/iterate | gopher-lua |  | 0.167 | 0.166 |  |  |  | 187.3 KiB | 9847 |
| text/iterate | quickjs |  | 0.0546 | 0.0522 |  |  |  |  |  |
| text/iterate | starlark-go |  | 0.108 | 0.108 |  |  |  | 62.0 KiB | 3607 |
| text/iterate | ts-native |  | 0.00107 | 0.00106 |  |  |  | 0 B |  |
| text/iterate | wasmoon |  | 0.0428 | 0.0394 |  |  |  |  |  |
| text/patterns | go | 50.1 | 4.303 | 4.258 | 13818 | 311.4 | 225.9 KiB | 7.8 MiB | 67199 |
| text/patterns | ts | 132.5 | 6.578 | 6.173 | 13818 | 476.0 | 225.9 KiB | 2.2 MiB |  |
| text/patterns | applescript |  | 15.529 | 15.378 |  |  |  |  |  |
| text/patterns | cpython |  | 0.0483 | 0.0481 |  |  |  | 1.2 KiB |  |
| text/patterns | go-native |  | 0.0593 | 0.0591 |  |  |  | 37.7 KiB | 1201 |
| text/patterns | gopher-lua |  | 0.248 | 0.247 |  |  |  | 390.8 KiB | 17736 |
| text/patterns | quickjs |  | 0.207 | 0.203 |  |  |  |  |  |
| text/patterns | starlark-go |  | 0.182 | 0.181 |  |  |  | 87.0 KiB | 4507 |
| text/patterns | ts-native |  | 0.0134 | 0.0134 |  |  |  | 116 B |  |
| text/patterns | wasmoon |  | 0.0599 | 0.0575 |  |  |  |  |  |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- numbers/quantity on ts: 1066.3 ns/Fuel, 3.4× the median
- collections/map-build on ts: 1291.0 ns/Fuel, 4.1× the median
- lifecycle/load-small on ts: 985.5 ns/Fuel, 3.1× the median
- host/pump on go: 562.4 ns/Fuel, 3.2× the median
- lifecycle/load-small on go: 577.4 ns/Fuel, 3.3× the median

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
