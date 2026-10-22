# Benchmark results, 2026-10-22

Commit `185d92d` on AMD EPYC 7763 64-Core Processor (4 cores, 16 GiB), linux x64.
Versions: bun 1.4.2, zig 0.17.0, zig build native safe; C Host zig cc -O2, cost model 0, go go1.27.3, language 1.0-rc.3, cpython 3.14.8, gopher-lua v1.1.2, quickjs-emscripten 0.32.0, starlark-go v0.0.0-20261005163335-bcb1a1a55bf9, wasmoon 1.16.0.
Settings: count 10, runners go,ts,zig,quickjs,ts-native,wasmoon,go-native,gopher-lua,starlark-go,cpython,applescript, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | go | 234.9 | 5.083 | 5.068 | 89459 | 56.8 | 195.6 KiB | 11.4 KiB | 158 |
| collections/iterate | ts | 1002.0 | 8.225 | 7.747 | 89459 | 91.9 | 195.6 KiB | 1.3 MiB |  |
| collections/iterate | zig | 45.8 | 1.128 | 1.090 | 89459 | 12.6 | 195.6 KiB |  |  |
| collections/iterate | cpython |  | 0.133 | 0.133 |  |  |  | 2.5 KiB |  |
| collections/iterate | go-native |  | 0.0373 | 0.0371 |  |  |  | 1.8 KiB | 4 |
| collections/iterate | gopher-lua |  | 0.941 | 0.940 |  |  |  | 108.9 KiB | 6741 |
| collections/iterate | quickjs |  | 0.419 | 0.405 |  |  |  |  |  |
| collections/iterate | starlark-go |  | 0.512 | 0.507 |  |  |  | 270.5 KiB | 783 |
| collections/iterate | ts-native |  | 0.0143 | 0.0130 |  |  |  | 1021 B |  |
| collections/iterate | wasmoon |  | 0.395 | 0.379 |  |  |  |  |  |
| collections/list-append | go | 201.2 | 4.605 | 4.593 | 52056 | 88.5 | 78.3 KiB | 27.3 KiB | 135 |
| collections/list-append | ts | 798.4 | 9.974 | 9.351 | 52056 | 191.6 | 78.3 KiB | 1.5 MiB |  |
| collections/list-append | zig | 32.8 | 1.058 | 1.033 | 52056 | 20.3 | 78.3 KiB |  |  |
| collections/list-append | cpython |  | 0.0850 | 0.0848 |  |  |  | 67.2 KiB |  |
| collections/list-append | go-native |  | 0.00450 | 0.00447 |  |  |  | 16.0 KiB | 2 |
| collections/list-append | gopher-lua |  | 0.461 | 0.459 |  |  |  | 203.9 KiB | 4315 |
| collections/list-append | quickjs |  | 0.347 | 0.320 |  |  |  |  |  |
| collections/list-append | starlark-go |  | 0.477 | 0.474 |  |  |  | 223.8 KiB | 4027 |
| collections/list-append | ts-native |  | 0.00941 | 0.00915 |  |  |  | 165 B |  |
| collections/list-append | wasmoon |  | 0.185 | 0.176 |  |  |  |  |  |
| collections/list-build | go | 167.0 | 0.960 | 0.955 | 19091 | 50.3 | 2.9 MiB | 7.1 KiB | 108 |
| collections/list-build | ts | 501.2 | 4.157 | 2.070 | 19091 | 217.7 | 2.9 MiB | 398.2 KiB |  |
| collections/list-build | zig | 22.9 | 0.215 | 0.214 | 19091 | 11.3 | 2.9 MiB |  |  |
| collections/list-build | cpython |  | 0.0171 | 0.0170 |  |  |  | 8.6 KiB |  |
| collections/list-build | go-native |  | 0.00139 | 0.00138 |  |  |  | 4.0 KiB | 2 |
| collections/list-build | gopher-lua |  | 0.0955 | 0.0952 |  |  |  | 35.4 KiB | 1045 |
| collections/list-build | quickjs |  | 0.0869 | 0.0795 |  |  |  |  |  |
| collections/list-build | starlark-go |  | 0.0548 | 0.0546 |  |  |  | 18.7 KiB | 18 |
| collections/list-build | ts-native |  | 0.00219 | 0.00211 |  |  |  | 20 B |  |
| collections/list-build | wasmoon |  | 0.0401 | 0.0356 |  |  |  |  |  |
| collections/list-update | go | 199.6 | 2.568 | 2.561 | 28553 | 89.9 | 23.8 KiB | 8.2 KiB | 120 |
| collections/list-update | ts | 803.2 | 7.291 | 6.986 | 28553 | 255.4 | 23.8 KiB | 962.2 KiB |  |
| collections/list-update | zig | 33.1 | 0.552 | 0.550 | 28553 | 19.3 | 23.8 KiB |  |  |
| collections/list-update | cpython |  | 0.0201 | 0.0201 |  |  |  | 184 B |  |
| collections/list-update | go-native |  | 0.000543 | 0.000540 |  |  |  | 72 B | 2 |
| collections/list-update | gopher-lua |  | 0.0686 | 0.0681 |  |  |  | 22.4 KiB | 106 |
| collections/list-update | quickjs |  | 0.0690 | 0.0680 |  |  |  |  |  |
| collections/list-update | starlark-go |  | 0.0929 | 0.0917 |  |  |  | 704 B | 13 |
| collections/list-update | ts-native |  | 0.00193 | 0.00192 |  |  |  | 116 B |  |
| collections/list-update | wasmoon |  | 0.0192 | 0.0167 |  |  |  |  |  |
| collections/map-build | go | 196.2 | 2.286 | 2.272 | 14094 | 162.2 | 24.3 KiB | 7.0 KiB | 107 |
| collections/map-build | ts | 631.4 | 2.557 | 2.230 | 14094 | 181.4 | 24.3 KiB | 344.8 KiB |  |
| collections/map-build | zig | 29.5 | 0.590 | 0.588 | 14094 | 41.9 | 24.3 KiB |  |  |
| collections/map-build | cpython |  | 0.0342 | 0.0339 |  |  |  | 19.3 KiB |  |
| collections/map-build | go-native |  | 0.0160 | 0.0159 |  |  |  | 13.9 KiB | 205 |
| collections/map-build | gopher-lua |  | 0.215 | 0.214 |  |  |  | 90.5 KiB | 1291 |
| collections/map-build | quickjs |  | 0.103 | 0.0949 |  |  |  |  |  |
| collections/map-build | starlark-go |  | 0.114 | 0.114 |  |  |  | 99.4 KiB | 827 |
| collections/map-build | ts-native |  | 0.0114 | 0.0106 |  |  |  | 329 B |  |
| collections/map-build | wasmoon |  | 0.118 | 0.111 |  |  |  |  |  |
| collections/map-update | go | 217.9 | 1.498 | 1.489 | 8056 | 186.0 | 12.1 KiB | 6.9 KiB | 106 |
| collections/map-update | ts | 725.3 | 3.332 | 3.038 | 8056 | 413.7 | 12.1 KiB | 402.5 KiB |  |
| collections/map-update | zig | 36.7 | 0.355 | 0.346 | 8056 | 44.1 | 12.1 KiB |  |  |
| collections/map-update | cpython |  | 0.00968 | 0.00963 |  |  |  | 480 B |  |
| collections/map-update | go-native |  | 0.00712 | 0.00710 |  |  |  | 520 B | 5 |
| collections/map-update | gopher-lua |  | 0.0481 | 0.0479 |  |  |  | 10.2 KiB | 76 |
| collections/map-update | quickjs |  | 0.0778 | 0.0759 |  |  |  |  |  |
| collections/map-update | starlark-go |  | 0.0402 | 0.0400 |  |  |  | 1.7 KiB | 11 |
| collections/map-update | ts-native |  | 0.00375 | 0.00372 |  |  |  | 7 B |  |
| collections/map-update | wasmoon |  | 0.0115 | 0.0103 |  |  |  |  |  |
| core/calls | go | 179.6 | 4.328 | 4.305 | 46018 | 94.1 | 31.3 KiB | 8.1 KiB | 121 |
| core/calls | ts | 579.0 | 3.840 | 3.495 | 46018 | 83.4 | 31.3 KiB | 155.7 KiB |  |
| core/calls | zig | 25.0 | 0.931 | 0.929 | 46018 | 20.2 | 31.3 KiB |  |  |
| core/calls | cpython |  | 0.0807 | 0.0805 |  |  |  | 0 B |  |
| core/calls | go-native |  | 0.000656 | 0.000654 |  |  |  | 8 B | 1 |
| core/calls | gopher-lua |  | 0.240 | 0.210 |  |  |  | 44.8 KiB | 180 |
| core/calls | quickjs |  | 0.219 | 0.214 |  |  |  |  |  |
| core/calls | starlark-go |  | 0.367 | 0.365 |  |  |  | 125.3 KiB | 2006 |
| core/calls | ts-native |  | 0.000940 | 0.000937 |  |  |  | 4 B |  |
| core/calls | wasmoon |  | 0.0850 | 0.0817 |  |  |  |  |  |
| core/fib | go | 168.9 | 3.693 | 3.666 | 46365 | 79.6 | 46.2 KiB | 7.9 KiB | 117 |
| core/fib | ts | 573.0 | 2.633 | 2.375 | 46365 | 56.8 | 46.2 KiB | 142.7 KiB |  |
| core/fib | zig | 23.7 | 0.769 | 0.766 | 46365 | 16.6 | 46.2 KiB |  |  |
| core/fib | cpython |  | 0.0629 | 0.0611 |  |  |  | 0 B |  |
| core/fib | go-native |  | 0.00354 | 0.00348 |  |  |  | 8 B | 1 |
| core/fib | gopher-lua |  | 0.182 | 0.181 |  |  |  | 63 B | 1 |
| core/fib | quickjs |  | 0.154 | 0.150 |  |  |  |  |  |
| core/fib | starlark-go |  | 0.401 | 0.399 |  |  |  | 154.2 KiB | 1975 |
| core/fib | ts-native |  | 0.00402 | 0.00400 |  |  |  | 0 B |  |
| core/fib | wasmoon |  | 0.0829 | 0.0781 |  |  |  |  |  |
| core/fib@slice=10 | go | 168.6 | 57.675 | 57.248 | 46365 | 1243.9 | 46.2 KiB | 9.5 MiB | 134553 |
| core/fib@slice=10 | ts | 435.9 | 18.999 | 16.189 | 46365 | 409.8 | 46.2 KiB | 1.7 MiB |  |
| core/fib@slice=10 | zig | 22.9 | 3.547 | 3.531 | 46365 | 76.5 | 46.2 KiB |  |  |
| core/fib@slice=100 | go | 169.3 | 9.671 | 9.614 | 46365 | 208.6 | 46.2 KiB | 985.0 KiB | 13543 |
| core/fib@slice=100 | ts | 407.1 | 3.919 | 3.671 | 46365 | 84.5 | 46.2 KiB | 31.8 KiB |  |
| core/fib@slice=100 | zig | 24.2 | 1.103 | 1.100 | 46365 | 23.8 | 46.2 KiB |  |  |
| core/fib@slice=1000 | go | 169.4 | 4.454 | 4.437 | 46365 | 96.1 | 46.2 KiB | 105.5 KiB | 1451 |
| core/fib@slice=1000 | ts | 349.6 | 2.688 | 2.584 | 46365 | 58.0 | 46.2 KiB | 13.1 KiB |  |
| core/fib@slice=1000 | zig | 24.3 | 0.791 | 0.790 | 46365 | 17.1 | 46.2 KiB |  |  |
| core/fib@slice=10000 | go | 169.2 | 3.893 | 3.866 | 46365 | 84.0 | 46.2 KiB | 16.6 KiB | 233 |
| core/fib@slice=10000 | ts | 342.0 | 2.536 | 2.434 | 46365 | 54.7 | 46.2 KiB | 9.2 KiB |  |
| core/fib@slice=10000 | zig | 24.3 | 0.769 | 0.767 | 46365 | 16.6 | 46.2 KiB |  |  |
| core/lambdas | go | 189.8 | 5.284 | 5.228 | 58027 | 91.1 | 62.6 KiB | 8.7 KiB | 127 |
| core/lambdas | ts | 716.6 | 5.853 | 4.409 | 58027 | 100.9 | 62.6 KiB | 257.1 KiB |  |
| core/lambdas | zig | 28.6 | 1.094 | 1.092 | 58027 | 18.9 | 62.6 KiB |  |  |
| core/lambdas | cpython |  | 0.108 | 0.107 |  |  |  | 208 B |  |
| core/lambdas | go-native |  | 0.00128 | 0.00128 |  |  |  | 8 B | 1 |
| core/lambdas | gopher-lua |  | 0.260 | 0.257 |  |  |  | 60.3 KiB | 244 |
| core/lambdas | quickjs |  | 0.235 | 0.233 |  |  |  |  |  |
| core/lambdas | starlark-go |  | 0.446 | 0.444 |  |  |  | 156.6 KiB | 2010 |
| core/lambdas | ts-native |  | 0.00173 | 0.00172 |  |  |  | 39 B |  |
| core/lambdas | wasmoon |  | 0.129 | 0.124 |  |  |  |  |  |
| core/loop | go | 159.7 | 1.732 | 1.725 | 48016 | 36.1 | 62.5 KiB | 9.1 KiB | 133 |
| core/loop | ts | 728.0 | 0.972 | 0.940 | 48016 | 20.2 | 62.5 KiB | 51.4 KiB |  |
| core/loop | zig | 21.5 | 0.416 | 0.413 | 48016 | 8.7 | 62.5 KiB |  |  |
| core/loop | cpython |  | 0.0396 | 0.0395 |  |  |  | 0 B |  |
| core/loop | go-native |  | 0.000655 | 0.000654 |  |  |  | 8 B | 1 |
| core/loop | gopher-lua |  | 0.0687 | 0.0683 |  |  |  | 44.8 KiB | 180 |
| core/loop | quickjs |  | 0.0713 | 0.0706 |  |  |  |  |  |
| core/loop | starlark-go |  | 0.127 | 0.124 |  |  |  | 256 B | 6 |
| core/loop | ts-native |  | 0.000939 | 0.000937 |  |  |  | 4 B |  |
| core/loop | wasmoon |  | 0.0222 | 0.0208 |  |  |  |  |  |
| host/conversion | go | 311.5 | 23.573 | 23.202 | 25018 | 942.3 | 220.3 KiB | 3.7 MiB | 62992 |
| host/conversion | ts | 718.7 | 31.188 | 27.587 | 25018 | 1246.6 | 220.3 KiB | 3.8 MiB |  |
| host/immediate | go | 291.6 | 7.080 | 7.001 | 13518 | 523.7 | 15.7 KiB | 1.1 MiB | 14137 |
| host/immediate | ts | 628.7 | 5.347 | 4.249 | 13518 | 395.6 | 15.7 KiB | 645.5 KiB |  |
| host/properties | go | 727.1 | 5.513 | 5.478 | 9018 | 611.3 | 15.7 KiB | 783.6 KiB | 9819 |
| host/properties | ts | 461.1 | 5.233 | 4.442 | 9018 | 580.3 | 15.7 KiB | 628.7 KiB |  |
| host/pump | go | 102.1 | 0.0479 | 0.0474 | 7 | 6835.8 | 0 B | 6.2 KiB | 94 |
| host/pump | ts | 122.7 | 0.0232 | 0.0214 | 7 | 3315.6 | 0 B | 930 B |  |
| host/pump | zig | 6.9 | 0.00334 | 0.00319 | 7 | 477.5 | 0 B |  |  |
| host/suspending | go | 294.5 | 29.461 | 29.150 | 13518 | 2179.4 | 15.7 KiB | 2.6 MiB | 39986 |
| host/suspending | ts | 619.0 | 23.121 | 19.999 | 13518 | 1710.4 | 15.7 KiB | 2.6 MiB |  |
| lifecycle/load-large | go | 5195.9 | 0.725 | 0.720 | 4609 | 157.3 | 16.3 KiB | 6.7 KiB | 99 |
| lifecycle/load-large | ts | 51154.3 | 1.500 | 1.333 | 4609 | 325.4 | 16.3 KiB | 181.6 KiB |  |
| lifecycle/load-large | zig | 2864.3 | 0.157 | 0.156 | 4609 | 34.1 | 16.3 KiB |  |  |
| lifecycle/load-small | go | 112.9 | 0.0464 | 0.0459 | 7 | 6625.1 | 0 B | 6.4 KiB | 95 |
| lifecycle/load-small | ts | 161.2 | 0.0174 | 0.0163 | 7 | 2486.0 | 0 B | 1.1 KiB |  |
| lifecycle/load-small | zig | 8.6 | 0.00329 | 0.00323 | 7 | 469.5 | 0 B |  |  |
| lifecycle/restore | go | 241.4 | 8.392 | 8.273 | 8015 | 1047.1 | 7.8 KiB | 7.2 MiB | 1149 |
| lifecycle/restore | ts | 952.3 | 17.357 | 15.184 | 8015 | 2165.6 | 7.8 KiB | 2.1 MiB |  |
| lifecycle/rollback | go | 373.0 | 207.237 | 205.511 | 102023 | 2031.3 | 39.9 KiB | 21.3 MiB | 284003 |
| lifecycle/rollback | ts | 1091.1 | 222.135 | 199.769 | 102023 | 2177.3 | 39.9 KiB | 9.9 MiB |  |
| macro/game-tick | go | 242.7 | 10.277 | 10.218 | 67042 | 153.3 | 78.4 KiB | 9.0 KiB | 130 |
| macro/game-tick | ts | 828.1 | 25.371 | 23.782 | 67042 | 378.4 | 78.4 KiB | 2.1 MiB |  |
| macro/game-tick | zig | 43.7 | 2.369 | 2.302 | 67042 | 35.3 | 78.4 KiB |  |  |
| macro/game-tick | cpython |  | 0.127 | 0.127 |  |  |  | 0 B |  |
| macro/game-tick | go-native |  | 0.000342 | 0.000341 |  |  |  | 8 B | 1 |
| macro/game-tick | gopher-lua |  | 0.339 | 0.334 |  |  |  | 28.7 KiB | 128 |
| macro/game-tick | quickjs |  | 0.173 | 0.171 |  |  |  |  |  |
| macro/game-tick | starlark-go |  | 0.501 | 0.498 |  |  |  | 94.5 KiB | 1007 |
| macro/game-tick | ts-native |  | 0.000721 | 0.000712 |  |  |  | 42 B |  |
| macro/game-tick | wasmoon |  | 0.106 | 0.0974 |  |  |  |  |  |
| macro/report | go | 177.7 | 3.298 | 3.279 | 86555 | 38.1 | 1.2 MiB | 6.6 KiB | 103 |
| macro/report | ts | 493.9 | 5.591 | 4.356 | 86555 | 64.6 | 1.2 MiB | 1.3 MiB |  |
| macro/report | zig | 25.4 | 1.001 | 0.973 | 86555 | 11.6 | 1.2 MiB |  |  |
| macro/report | cpython |  | 0.0511 | 0.0509 |  |  |  | 14.8 KiB |  |
| macro/report | go-native |  | 0.0232 | 0.0230 |  |  |  | 8.8 KiB | 85 |
| macro/report | gopher-lua |  | 0.350 | 0.349 |  |  |  | 33.1 KiB | 1291 |
| macro/report | quickjs |  | 0.110 | 0.108 |  |  |  |  |  |
| macro/report | starlark-go |  | 0.177 | 0.175 |  |  |  | 66.2 KiB | 3084 |
| macro/report | ts-native |  | 0.00854 | 0.00838 |  |  |  | 68 B |  |
| macro/report | wasmoon |  | 0.119 | 0.104 |  |  |  |  |  |
| macro/transform | go | 212.4 | 2.000 | 1.992 | 20664 | 96.8 | 6.1 MiB | 14.8 KiB | 109 |
| macro/transform | ts | 649.6 | 8.477 | 7.560 | 20664 | 410.2 | 6.1 MiB | 1.0 MiB |  |
| macro/transform | zig | 36.0 | 0.451 | 0.438 | 20664 | 21.8 | 6.1 MiB |  |  |
| macro/transform | cpython |  | 0.0414 | 0.0413 |  |  |  | 48.0 KiB |  |
| macro/transform | go-native |  | 0.00216 | 0.00211 |  |  |  | 7.4 KiB | 3 |
| macro/transform | gopher-lua |  | 0.345 | 0.343 |  |  |  | 268.0 KiB | 4538 |
| macro/transform | quickjs |  | 0.136 | 0.134 |  |  |  |  |  |
| macro/transform | starlark-go |  | 0.151 | 0.150 |  |  |  | 168.7 KiB | 328 |
| macro/transform | ts-native |  | 0.00568 | 0.00557 |  |  |  | 25 B |  |
| macro/transform | wasmoon |  | 0.108 | 0.0886 |  |  |  |  |  |
| messaging/joins | go | 308.0 | 33.571 | 32.699 | 127218 | 263.9 | 239.1 KiB | 6.8 MiB | 58563 |
| messaging/joins | ts | 957.5 | 102.654 | 97.815 | 127218 | 806.9 | 239.1 KiB | 5.5 MiB |  |
| messaging/parents | go | 744.9 | 20.506 | 20.294 | 67518 | 303.7 | 93.8 KiB | 3.8 MiB | 37427 |
| messaging/parents | ts | 674.4 | 77.292 | 73.599 | 67518 | 1144.8 | 93.8 KiB | 5.0 MiB |  |
| messaging/sends | go | 287.6 | 20.526 | 20.283 | 67518 | 304.0 | 93.8 KiB | 3.6 MiB | 37425 |
| messaging/sends | ts | 756.3 | 62.474 | 45.817 | 67518 | 925.3 | 93.8 KiB | 5.6 MiB |  |
| messaging/suspend | go | 166.4 | 37.271 | 37.012 | 48018 | 776.2 | 31.3 KiB | 4.1 MiB | 58114 |
| messaging/suspend | ts | 442.3 | 21.132 | 18.835 | 48018 | 440.1 | 31.3 KiB | 2.5 MiB |  |
| messaging/suspend | zig | 21.4 | 3.092 | 2.968 | 48018 | 64.4 | 31.3 KiB |  |  |
| numbers/add | go | 164.4 | 1.732 | 1.723 | 26030 | 66.5 | 31.4 KiB | 7.8 KiB | 118 |
| numbers/add | ts | 526.0 | 4.028 | 3.810 | 26030 | 154.7 | 31.4 KiB | 352.4 KiB |  |
| numbers/add | zig | 21.7 | 0.424 | 0.421 | 26030 | 16.3 | 31.4 KiB |  |  |
| numbers/add | cpython |  | 0.0377 | 0.0376 |  |  |  | 0 B |  |
| numbers/add | go-native |  | 0.00188 | 0.00188 |  |  |  | 8 B | 1 |
| numbers/add | gopher-lua |  | 0.0718 | 0.0713 |  |  |  | 43.9 KiB | 177 |
| numbers/add | quickjs |  | 0.0748 | 0.0731 |  |  |  |  |  |
| numbers/add | starlark-go |  | 0.137 | 0.136 |  |  |  | 15.9 KiB | 2010 |
| numbers/add | ts-native |  | 0.00184 | 0.00183 |  |  |  | 0 B |  |
| numbers/add | wasmoon |  | 0.0244 | 0.0213 |  |  |  |  |  |
| numbers/divide | go | 165.1 | 1.353 | 1.349 | 18031 | 75.0 | 31.4 KiB | 7.3 KiB | 111 |
| numbers/divide | ts | 521.5 | 3.208 | 3.064 | 18031 | 177.9 | 31.4 KiB | 296.7 KiB |  |
| numbers/divide | zig | 22.8 | 0.305 | 0.302 | 18031 | 16.9 | 31.4 KiB |  |  |
| numbers/divide | cpython |  | 0.0329 | 0.0329 |  |  |  | 0 B |  |
| numbers/divide | go-native |  | 0.000958 | 0.000955 |  |  |  | 8 B | 1 |
| numbers/divide | gopher-lua |  | 0.0533 | 0.0530 |  |  |  | 28.3 KiB | 115 |
| numbers/divide | quickjs |  | 0.0604 | 0.0603 |  |  |  |  |  |
| numbers/divide | starlark-go |  | 0.112 | 0.112 |  |  |  | 15.9 KiB | 2010 |
| numbers/divide | ts-native |  | 0.000926 | 0.000923 |  |  |  | 0 B |  |
| numbers/divide | wasmoon |  | 0.0204 | 0.0182 |  |  |  |  |  |
| numbers/multiply | go | 167.5 | 1.117 | 1.114 | 18031 | 62.0 | 31.4 KiB | 7.3 KiB | 111 |
| numbers/multiply | ts | 527.8 | 2.680 | 2.521 | 18031 | 148.6 | 31.4 KiB | 331.3 KiB |  |
| numbers/multiply | zig | 22.2 | 0.254 | 0.254 | 18031 | 14.1 | 31.4 KiB |  |  |
| numbers/multiply | cpython |  | 0.0355 | 0.0354 |  |  |  | 0 B |  |
| numbers/multiply | go-native |  | 0.000956 | 0.000954 |  |  |  | 8 B | 1 |
| numbers/multiply | gopher-lua |  | 0.0501 | 0.0497 |  |  |  | 29.1 KiB | 118 |
| numbers/multiply | quickjs |  | 0.0834 | 0.0787 |  |  |  |  |  |
| numbers/multiply | starlark-go |  | 0.108 | 0.107 |  |  |  | 15.9 KiB | 2010 |
| numbers/multiply | ts-native |  | 0.000925 | 0.000916 |  |  |  | 6 B |  |
| numbers/multiply | wasmoon |  | 0.0225 | 0.0200 |  |  |  |  |  |
| numbers/quantity | go | 195.9 | 1.251 | 1.242 | 14579 | 85.8 | 39.1 KiB | 7.0 KiB | 108 |
| numbers/quantity | ts | 569.2 | 3.935 | 3.489 | 14579 | 269.9 | 39.1 KiB | 500.0 KiB |  |
| numbers/quantity | zig | 27.4 | 0.292 | 0.289 | 14579 | 20.1 | 39.1 KiB |  |  |
| numbers/quantity | cpython |  | 0.0227 | 0.0227 |  |  |  | 0 B |  |
| numbers/quantity | go-native |  | 0.000719 | 0.000718 |  |  |  | 8 B | 1 |
| numbers/quantity | gopher-lua |  | 0.0331 | 0.0322 |  |  |  | 16.5 KiB | 67 |
| numbers/quantity | quickjs |  | 0.0314 | 0.0313 |  |  |  |  |  |
| numbers/quantity | starlark-go |  | 0.0710 | 0.0707 |  |  |  | 8.1 KiB | 1009 |
| numbers/quantity | ts-native |  | 0.000599 | 0.000597 |  |  |  | 0 B |  |
| numbers/quantity | wasmoon |  | 0.0148 | 0.0131 |  |  |  |  |  |
| text/build | go | 155.8 | 0.734 | 0.731 | 28928 | 25.4 | 374.8 KiB | 6.6 KiB | 104 |
| text/build | ts | 373.4 | 2.113 | 2.012 | 28928 | 73.0 | 374.8 KiB | 201.1 KiB |  |
| text/build | zig | 19.1 | 0.150 | 0.150 | 28928 | 5.2 | 374.8 KiB |  |  |
| text/build | cpython |  | 0.0194 | 0.0194 |  |  |  | 1.5 KiB |  |
| text/build | go-native |  | 0.127 | 0.116 |  |  |  | 387.1 KiB | 500 |
| text/build | gopher-lua |  | 0.176 | 0.174 |  |  |  | 400.8 KiB | 1024 |
| text/build | quickjs |  | 0.0521 | 0.0506 |  |  |  |  |  |
| text/build | starlark-go |  | 0.163 | 0.163 |  |  |  | 395.1 KiB | 1006 |
| text/build | ts-native |  | 0.00174 | 0.00167 |  |  |  | 96 B |  |
| text/build | wasmoon |  | 0.0949 | 0.0892 |  |  |  |  |  |
| text/graphemes | go | 177.2 | 6.966 | 6.920 | 43518 | 160.1 | 144.1 KiB | 8.3 KiB | 122 |
| text/graphemes | ts | 471.4 | 24.482 | 21.852 | 43518 | 562.6 | 144.1 KiB | 2.7 MiB |  |
| text/graphemes | zig | 24.1 | 1.809 | 1.800 | 43518 | 41.6 | 144.1 KiB |  |  |
| text/index | go | 181.9 | 3.997 | 3.992 | 26640 | 150.1 | 49.9 KiB | 7.4 KiB | 113 |
| text/index | ts | 496.2 | 6.634 | 5.411 | 26640 | 249.0 | 49.9 KiB | 533.3 KiB |  |
| text/index | zig | 27.3 | 1.098 | 1.097 | 26640 | 41.2 | 49.9 KiB |  |  |
| text/index | cpython |  | 0.0365 | 0.0364 |  |  |  | 0 B |  |
| text/index | go-native |  | 0.00113 | 0.00112 |  |  |  | 0 B | 0 |
| text/index | gopher-lua |  | 0.250 | 0.247 |  |  |  | 29.3 KiB | 1055 |
| text/index | quickjs |  | 0.131 | 0.126 |  |  |  |  |  |
| text/index | starlark-go |  | 0.157 | 0.156 |  |  |  | 15.9 KiB | 1006 |
| text/index | ts-native |  | 0.00171 | 0.00171 |  |  |  | 0 B |  |
| text/index | wasmoon |  | 0.106 | 0.0963 |  |  |  |  |  |
| text/iterate | go | 171.1 | 2.746 | 2.732 | 30318 | 90.6 | 93.0 KiB | 7.7 KiB | 116 |
| text/iterate | ts | 409.3 | 6.888 | 6.203 | 30318 | 227.2 | 93.0 KiB | 686.7 KiB |  |
| text/iterate | zig | 22.8 | 0.648 | 0.645 | 30318 | 21.4 | 93.0 KiB |  |  |
| text/iterate | cpython |  | 0.0468 | 0.0467 |  |  |  | 48 B |  |
| text/iterate | go-native |  | 0.00109 | 0.00109 |  |  |  | 8 B | 1 |
| text/iterate | gopher-lua |  | 0.453 | 0.446 |  |  |  | 187.3 KiB | 9847 |
| text/iterate | quickjs |  | 0.162 | 0.160 |  |  |  |  |  |
| text/iterate | starlark-go |  | 0.350 | 0.346 |  |  |  | 62.0 KiB | 3607 |
| text/iterate | ts-native |  | 0.00237 | 0.00236 |  |  |  | 0 B |  |
| text/iterate | wasmoon |  | 0.137 | 0.128 |  |  |  |  |  |
| text/patterns | go | 183.3 | 4.444 | 4.427 | 13818 | 321.6 | 225.9 KiB | 6.7 KiB | 104 |
| text/patterns | ts | 557.3 | 14.581 | 12.964 | 13818 | 1055.3 | 225.9 KiB | 1.7 MiB |  |
| text/patterns | zig | 24.4 | 1.365 | 1.363 | 13818 | 98.8 | 225.9 KiB |  |  |
| text/patterns | cpython |  | 0.131 | 0.131 |  |  |  | 1.2 KiB |  |
| text/patterns | go-native |  | 0.170 | 0.170 |  |  |  | 37.7 KiB | 1201 |
| text/patterns | gopher-lua |  | 0.711 | 0.702 |  |  |  | 390.8 KiB | 17736 |
| text/patterns | quickjs |  | 0.622 | 0.606 |  |  |  |  |  |
| text/patterns | starlark-go |  | 0.517 | 0.512 |  |  |  | 87.0 KiB | 4507 |
| text/patterns | ts-native |  | 0.0358 | 0.0356 |  |  |  | 845 B |  |
| text/patterns | wasmoon |  | 0.177 | 0.170 |  |  |  |  |  |

## Payload

What a browser Host ships to embed each Core: bundled with `Bun.build --target browser --minify`, compressed with `node:zlib`.

| Payload | Brotli | gzip -9 | Raw |
| - | -: | -: | -: |
| TS Core: Example Host | 150.8 KiB | 177.5 KiB | 610.5 KiB |
| TS Core: @northtalk/ts | 150.3 KiB | 176.8 KiB | 609.0 KiB |
| Zig Core: Example Host + talk.wasm | 857.9 KiB | 1.2 MiB | 3.7 MiB |
| Zig ÷ TS Example Host | 5.7× | 7.0× | 6.2× |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- core/fib@slice=10 on zig: 76.5 ns/Fuel, 3.8× the median
- text/patterns on zig: 98.8 ns/Fuel, 4.9× the median
- host/pump on zig: 477.5 ns/Fuel, 23.5× the median
- messaging/suspend on zig: 64.4 ns/Fuel, 3.2× the median
- lifecycle/load-small on zig: 469.5 ns/Fuel, 23.2× the median
- text/patterns on ts: 1055.3 ns/Fuel, 4.0× the median
- host/suspending on ts: 1710.4 ns/Fuel, 6.5× the median
- host/conversion on ts: 1246.6 ns/Fuel, 4.7× the median
- host/pump on ts: 3315.6 ns/Fuel, 12.6× the median
- messaging/sends on ts: 925.3 ns/Fuel, 3.5× the median
- messaging/parents on ts: 1144.8 ns/Fuel, 4.4× the median
- messaging/joins on ts: 806.9 ns/Fuel, 3.1× the median
- lifecycle/load-small on ts: 2486.0 ns/Fuel, 9.5× the median
- lifecycle/rollback on ts: 2177.3 ns/Fuel, 8.3× the median
- core/fib@slice=10 on go: 1243.9 ns/Fuel, 8.2× the median
- host/immediate on go: 523.7 ns/Fuel, 3.5× the median
- host/suspending on go: 2179.4 ns/Fuel, 14.4× the median
- host/properties on go: 611.3 ns/Fuel, 4.0× the median
- host/conversion on go: 942.3 ns/Fuel, 6.2× the median
- host/pump on go: 6835.8 ns/Fuel, 45.1× the median
- messaging/suspend on go: 776.2 ns/Fuel, 5.1× the median
- lifecycle/load-small on go: 6625.1 ns/Fuel, 43.7× the median
- lifecycle/rollback on go: 2031.3 ns/Fuel, 13.4× the median

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
