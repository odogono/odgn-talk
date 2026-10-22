# Benchmark results, 2026-10-22

Commit `bf83296` on AMD EPYC 7763 64-Core Processor (4 cores, 16 GiB), linux x64.
Versions: bun 1.4.2, zig 0.17.0, zig build native safe; C Host zig cc -O2, cost model 0, go go1.27.3, language 1.0-rc.3, cpython 3.14.8, gopher-lua v1.1.2, quickjs-emscripten 0.32.0, starlark-go v0.0.0-20261005163335-bcb1a1a55bf9, wasmoon 1.16.0.
Settings: count 10, runners go,ts,zig,quickjs,ts-native,wasmoon,go-native,gopher-lua,starlark-go,cpython,applescript, smoke false.

| Benchmark | Runner | Load median (µs) | Run median (ms) | Run min (ms) | Fuel | ns/Fuel | Logical alloc | Host bytes | Host allocs |
| - | - | -: | -: | -: | -: | -: | -: | -: | -: |
| collections/iterate | go | 237.1 | 5.254 | 5.237 | 89459 | 58.7 | 195.6 KiB | 11.4 KiB | 158 |
| collections/iterate | ts | 1013.0 | 9.294 | 7.846 | 89459 | 103.9 | 195.6 KiB | 1.7 MiB |  |
| collections/iterate | zig | 44.0 | 1.103 | 1.092 | 89459 | 12.3 | 195.6 KiB |  |  |
| collections/iterate | cpython |  | 0.134 | 0.133 |  |  |  | 2.5 KiB |  |
| collections/iterate | go-native |  | 0.0375 | 0.0374 |  |  |  | 1.8 KiB | 4 |
| collections/iterate | gopher-lua |  | 0.935 | 0.929 |  |  |  | 108.9 KiB | 6741 |
| collections/iterate | quickjs |  | 0.425 | 0.409 |  |  |  |  |  |
| collections/iterate | starlark-go |  | 0.511 | 0.508 |  |  |  | 270.5 KiB | 783 |
| collections/iterate | ts-native |  | 0.0149 | 0.0144 |  |  |  | 1.0 KiB |  |
| collections/iterate | wasmoon |  | 0.397 | 0.375 |  |  |  |  |  |
| collections/list-append | go | 201.6 | 4.724 | 4.697 | 52056 | 90.7 | 78.3 KiB | 27.7 KiB | 135 |
| collections/list-append | ts | 806.7 | 10.248 | 9.583 | 52056 | 196.9 | 78.3 KiB | 1.5 MiB |  |
| collections/list-append | zig | 33.2 | 1.095 | 1.070 | 52056 | 21.0 | 78.3 KiB |  |  |
| collections/list-append | cpython |  | 0.0853 | 0.0852 |  |  |  | 67.2 KiB |  |
| collections/list-append | go-native |  | 0.00466 | 0.00462 |  |  |  | 16.0 KiB | 2 |
| collections/list-append | gopher-lua |  | 0.462 | 0.460 |  |  |  | 203.9 KiB | 4315 |
| collections/list-append | quickjs |  | 0.346 | 0.319 |  |  |  |  |  |
| collections/list-append | starlark-go |  | 0.475 | 0.471 |  |  |  | 223.8 KiB | 4027 |
| collections/list-append | ts-native |  | 0.00897 | 0.00894 |  |  |  | 110 B |  |
| collections/list-append | wasmoon |  | 0.183 | 0.174 |  |  |  |  |  |
| collections/list-build | go | 168.5 | 0.988 | 0.984 | 19091 | 51.8 | 2.9 MiB | 7.1 KiB | 108 |
| collections/list-build | ts | 503.2 | 4.220 | 2.074 | 19091 | 221.0 | 2.9 MiB | 392.1 KiB |  |
| collections/list-build | zig | 23.0 | 0.214 | 0.214 | 19091 | 11.2 | 2.9 MiB |  |  |
| collections/list-build | cpython |  | 0.0171 | 0.0171 |  |  |  | 8.6 KiB |  |
| collections/list-build | go-native |  | 0.00145 | 0.00143 |  |  |  | 4.0 KiB | 2 |
| collections/list-build | gopher-lua |  | 0.0959 | 0.0954 |  |  |  | 35.4 KiB | 1045 |
| collections/list-build | quickjs |  | 0.0878 | 0.0800 |  |  |  |  |  |
| collections/list-build | starlark-go |  | 0.0549 | 0.0546 |  |  |  | 18.7 KiB | 18 |
| collections/list-build | ts-native |  | 0.00228 | 0.00216 |  |  |  | 40 B |  |
| collections/list-build | wasmoon |  | 0.0399 | 0.0352 |  |  |  |  |  |
| collections/list-update | go | 200.7 | 2.641 | 2.625 | 28553 | 92.5 | 23.8 KiB | 8.2 KiB | 120 |
| collections/list-update | ts | 803.4 | 7.546 | 7.176 | 28553 | 264.3 | 23.8 KiB | 928.6 KiB |  |
| collections/list-update | zig | 33.4 | 0.550 | 0.547 | 28553 | 19.3 | 23.8 KiB |  |  |
| collections/list-update | cpython |  | 0.0203 | 0.0201 |  |  |  | 184 B |  |
| collections/list-update | go-native |  | 0.000546 | 0.000544 |  |  |  | 72 B | 2 |
| collections/list-update | gopher-lua |  | 0.0684 | 0.0679 |  |  |  | 22.4 KiB | 106 |
| collections/list-update | quickjs |  | 0.0656 | 0.0639 |  |  |  |  |  |
| collections/list-update | starlark-go |  | 0.0926 | 0.0905 |  |  |  | 704 B | 13 |
| collections/list-update | ts-native |  | 0.00194 | 0.00192 |  |  |  | 122 B |  |
| collections/list-update | wasmoon |  | 0.0196 | 0.0169 |  |  |  |  |  |
| collections/map-build | go | 195.5 | 2.321 | 2.312 | 14094 | 164.7 | 24.3 KiB | 7.0 KiB | 107 |
| collections/map-build | ts | 644.9 | 2.646 | 2.252 | 14094 | 187.7 | 24.3 KiB | 378.1 KiB |  |
| collections/map-build | zig | 29.6 | 0.591 | 0.589 | 14094 | 41.9 | 24.3 KiB |  |  |
| collections/map-build | cpython |  | 0.0334 | 0.0333 |  |  |  | 19.3 KiB |  |
| collections/map-build | go-native |  | 0.0164 | 0.0163 |  |  |  | 13.9 KiB | 205 |
| collections/map-build | gopher-lua |  | 0.217 | 0.216 |  |  |  | 90.5 KiB | 1291 |
| collections/map-build | quickjs |  | 0.101 | 0.0924 |  |  |  |  |  |
| collections/map-build | starlark-go |  | 0.114 | 0.113 |  |  |  | 99.4 KiB | 827 |
| collections/map-build | ts-native |  | 0.0105 | 0.0103 |  |  |  | 260 B |  |
| collections/map-build | wasmoon |  | 0.119 | 0.112 |  |  |  |  |  |
| collections/map-update | go | 219.9 | 1.537 | 1.532 | 8056 | 190.8 | 12.1 KiB | 6.9 KiB | 106 |
| collections/map-update | ts | 720.4 | 3.429 | 3.212 | 8056 | 425.7 | 12.1 KiB | 423.5 KiB |  |
| collections/map-update | zig | 36.0 | 0.350 | 0.349 | 8056 | 43.5 | 12.1 KiB |  |  |
| collections/map-update | cpython |  | 0.00963 | 0.00958 |  |  |  | 480 B |  |
| collections/map-update | go-native |  | 0.00713 | 0.00711 |  |  |  | 520 B | 5 |
| collections/map-update | gopher-lua |  | 0.0483 | 0.0481 |  |  |  | 10.2 KiB | 76 |
| collections/map-update | quickjs |  | 0.0774 | 0.0736 |  |  |  |  |  |
| collections/map-update | starlark-go |  | 0.0401 | 0.0398 |  |  |  | 1.7 KiB | 11 |
| collections/map-update | ts-native |  | 0.00378 | 0.00375 |  |  |  | 4 B |  |
| collections/map-update | wasmoon |  | 0.0119 | 0.0104 |  |  |  |  |  |
| core/calls | go | 183.8 | 4.506 | 4.439 | 46018 | 97.9 | 31.3 KiB | 8.1 KiB | 121 |
| core/calls | ts | 589.9 | 3.524 | 3.324 | 46018 | 76.6 | 31.3 KiB | 158.1 KiB |  |
| core/calls | zig | 25.4 | 0.934 | 0.932 | 46018 | 20.3 | 31.3 KiB |  |  |
| core/calls | cpython |  | 0.0817 | 0.0812 |  |  |  | 0 B |  |
| core/calls | go-native |  | 0.000656 | 0.000654 |  |  |  | 8 B | 1 |
| core/calls | gopher-lua |  | 0.222 | 0.221 |  |  |  | 44.8 KiB | 180 |
| core/calls | quickjs |  | 0.224 | 0.218 |  |  |  |  |  |
| core/calls | starlark-go |  | 0.365 | 0.362 |  |  |  | 125.3 KiB | 2006 |
| core/calls | ts-native |  | 0.000940 | 0.000937 |  |  |  | 4 B |  |
| core/calls | wasmoon |  | 0.0859 | 0.0825 |  |  |  |  |  |
| core/fib | go | 171.1 | 3.843 | 3.825 | 46365 | 82.9 | 46.2 KiB | 7.9 KiB | 117 |
| core/fib | ts | 673.8 | 2.601 | 2.231 | 46365 | 56.1 | 46.2 KiB | 133.8 KiB |  |
| core/fib | zig | 23.2 | 0.770 | 0.768 | 46365 | 16.6 | 46.2 KiB |  |  |
| core/fib | cpython |  | 0.0635 | 0.0634 |  |  |  | 0 B |  |
| core/fib | go-native |  | 0.00352 | 0.00337 |  |  |  | 8 B | 1 |
| core/fib | gopher-lua |  | 0.182 | 0.181 |  |  |  | 63 B | 1 |
| core/fib | quickjs |  | 0.150 | 0.148 |  |  |  |  |  |
| core/fib | starlark-go |  | 0.403 | 0.398 |  |  |  | 154.2 KiB | 1975 |
| core/fib | ts-native |  | 0.00398 | 0.00397 |  |  |  | 0 B |  |
| core/fib | wasmoon |  | 0.0825 | 0.0779 |  |  |  |  |  |
| core/fib@slice=10 | go | 173.5 | 60.080 | 59.731 | 46365 | 1295.8 | 46.2 KiB | 9.5 MiB | 134553 |
| core/fib@slice=10 | ts | 443.5 | 17.872 | 16.516 | 46365 | 385.5 | 46.2 KiB | 1.1 MiB |  |
| core/fib@slice=10 | zig | 23.1 | 3.655 | 3.637 | 46365 | 78.8 | 46.2 KiB |  |  |
| core/fib@slice=100 | go | 173.4 | 10.055 | 9.960 | 46365 | 216.9 | 46.2 KiB | 984.2 KiB | 13543 |
| core/fib@slice=100 | ts | 420.9 | 3.996 | 3.783 | 46365 | 86.2 | 46.2 KiB | 21.3 KiB |  |
| core/fib@slice=100 | zig | 24.6 | 1.101 | 1.100 | 46365 | 23.7 | 46.2 KiB |  |  |
| core/fib@slice=1000 | go | 172.2 | 4.638 | 4.611 | 46365 | 100.0 | 46.2 KiB | 105.5 KiB | 1451 |
| core/fib@slice=1000 | ts | 372.3 | 2.531 | 2.434 | 46365 | 54.6 | 46.2 KiB | 19.2 KiB |  |
| core/fib@slice=1000 | zig | 24.8 | 0.866 | 0.864 | 46365 | 18.7 | 46.2 KiB |  |  |
| core/fib@slice=10000 | go | 172.1 | 4.042 | 4.032 | 46365 | 87.2 | 46.2 KiB | 16.6 KiB | 233 |
| core/fib@slice=10000 | ts | 366.6 | 2.353 | 2.278 | 46365 | 50.7 | 46.2 KiB | 10.4 KiB |  |
| core/fib@slice=10000 | zig | 24.5 | 0.800 | 0.798 | 46365 | 17.3 | 46.2 KiB |  |  |
| core/lambdas | go | 197.1 | 5.413 | 5.380 | 58027 | 93.3 | 62.6 KiB | 8.7 KiB | 127 |
| core/lambdas | ts | 724.2 | 5.712 | 4.362 | 58027 | 98.4 | 62.6 KiB | 311.9 KiB |  |
| core/lambdas | zig | 28.9 | 1.112 | 1.111 | 58027 | 19.2 | 62.6 KiB |  |  |
| core/lambdas | cpython |  | 0.107 | 0.106 |  |  |  | 208 B |  |
| core/lambdas | go-native |  | 0.00128 | 0.00128 |  |  |  | 8 B | 1 |
| core/lambdas | gopher-lua |  | 0.274 | 0.272 |  |  |  | 60.3 KiB | 244 |
| core/lambdas | quickjs |  | 0.236 | 0.234 |  |  |  |  |  |
| core/lambdas | starlark-go |  | 0.447 | 0.445 |  |  |  | 156.6 KiB | 2010 |
| core/lambdas | ts-native |  | 0.00173 | 0.00172 |  |  |  | 39 B |  |
| core/lambdas | wasmoon |  | 0.128 | 0.124 |  |  |  |  |  |
| core/loop | go | 164.6 | 1.751 | 1.747 | 48016 | 36.5 | 62.5 KiB | 9.1 KiB | 133 |
| core/loop | ts | 690.2 | 0.992 | 0.936 | 48016 | 20.7 | 62.5 KiB | 56.4 KiB |  |
| core/loop | zig | 21.4 | 0.406 | 0.405 | 48016 | 8.4 | 62.5 KiB |  |  |
| core/loop | cpython |  | 0.0397 | 0.0396 |  |  |  | 0 B |  |
| core/loop | go-native |  | 0.000657 | 0.000655 |  |  |  | 8 B | 1 |
| core/loop | gopher-lua |  | 0.0689 | 0.0686 |  |  |  | 44.8 KiB | 180 |
| core/loop | quickjs |  | 0.0732 | 0.0725 |  |  |  |  |  |
| core/loop | starlark-go |  | 0.127 | 0.123 |  |  |  | 256 B | 6 |
| core/loop | ts-native |  | 0.000939 | 0.000936 |  |  |  | 3 B |  |
| core/loop | wasmoon |  | 0.0189 | 0.0161 |  |  |  |  |  |
| host/conversion | go | 312.6 | 24.325 | 23.721 | 25018 | 972.3 | 220.3 KiB | 3.7 MiB | 62992 |
| host/conversion | ts | 703.9 | 31.796 | 28.985 | 25018 | 1270.9 | 220.3 KiB | 2.6 MiB |  |
| host/immediate | go | 293.6 | 7.230 | 7.163 | 13518 | 534.9 | 15.7 KiB | 1.1 MiB | 14128 |
| host/immediate | ts | 644.8 | 5.305 | 4.293 | 13518 | 392.4 | 15.7 KiB | 588.5 KiB |  |
| host/properties | go | 743.0 | 5.437 | 5.379 | 9018 | 603.0 | 15.7 KiB | 783.6 KiB | 9821 |
| host/properties | ts | 469.4 | 4.836 | 4.374 | 9018 | 536.2 | 15.7 KiB | 560.8 KiB |  |
| host/pump | go | 106.5 | 0.0485 | 0.0482 | 7 | 6928.0 | 0 B | 6.2 KiB | 94 |
| host/pump | ts | 122.8 | 0.0236 | 0.0221 | 7 | 3364.3 | 0 B | 1.3 KiB |  |
| host/pump | zig | 6.7 | 0.00334 | 0.00332 | 7 | 477.4 | 0 B |  |  |
| host/suspending | go | 296.6 | 29.986 | 29.702 | 13518 | 2218.2 | 15.7 KiB | 2.6 MiB | 39985 |
| host/suspending | ts | 619.1 | 22.528 | 21.123 | 13518 | 1666.5 | 15.7 KiB | 2.4 MiB |  |
| lifecycle/load-large | go | 5369.8 | 0.735 | 0.730 | 4609 | 159.5 | 16.3 KiB | 6.7 KiB | 99 |
| lifecycle/load-large | ts | 50026.7 | 1.577 | 1.431 | 4609 | 342.1 | 16.3 KiB | 187.9 KiB |  |
| lifecycle/load-large | zig | 2806.1 | 0.159 | 0.158 | 4609 | 34.5 | 16.3 KiB |  |  |
| lifecycle/load-small | go | 113.9 | 0.0483 | 0.0479 | 7 | 6898.8 | 0 B | 6.4 KiB | 95 |
| lifecycle/load-small | ts | 159.7 | 0.0165 | 0.0148 | 7 | 2355.8 | 0 B | 1.3 KiB |  |
| lifecycle/load-small | zig | 8.6 | 0.00329 | 0.00327 | 7 | 469.8 | 0 B |  |  |
| lifecycle/restore | go | 247.3 | 8.730 | 8.537 | 8015 | 1089.2 | 7.8 KiB | 7.2 MiB | 1149 |
| lifecycle/restore | ts | 948.2 | 15.941 | 13.914 | 8015 | 1988.9 | 7.8 KiB | 2.0 MiB |  |
| lifecycle/rollback | go | 377.1 | 215.448 | 214.948 | 102023 | 2111.8 | 39.9 KiB | 21.3 MiB | 284003 |
| lifecycle/rollback | ts | 1058.1 | 231.556 | 220.383 | 102023 | 2269.6 | 39.9 KiB | 7.9 MiB |  |
| macro/game-tick | go | 240.8 | 10.561 | 10.522 | 67042 | 157.5 | 78.4 KiB | 9.0 KiB | 130 |
| macro/game-tick | ts | 800.3 | 25.587 | 24.825 | 67042 | 381.7 | 78.4 KiB | 1.7 MiB |  |
| macro/game-tick | zig | 42.1 | 2.364 | 2.359 | 67042 | 35.3 | 78.4 KiB |  |  |
| macro/game-tick | cpython |  | 0.130 | 0.129 |  |  |  | 0 B |  |
| macro/game-tick | go-native |  | 0.000342 | 0.000341 |  |  |  | 8 B | 1 |
| macro/game-tick | gopher-lua |  | 0.336 | 0.335 |  |  |  | 28.7 KiB | 128 |
| macro/game-tick | quickjs |  | 0.172 | 0.170 |  |  |  |  |  |
| macro/game-tick | starlark-go |  | 0.504 | 0.502 |  |  |  | 94.5 KiB | 1007 |
| macro/game-tick | ts-native |  | 0.000715 | 0.000711 |  |  |  | 42 B |  |
| macro/game-tick | wasmoon |  | 0.107 | 0.100 |  |  |  |  |  |
| macro/report | go | 183.5 | 3.326 | 3.312 | 86555 | 38.4 | 1.2 MiB | 6.6 KiB | 103 |
| macro/report | ts | 483.5 | 5.023 | 4.531 | 86555 | 58.0 | 1.2 MiB | 1.3 MiB |  |
| macro/report | zig | 25.3 | 0.973 | 0.971 | 86555 | 11.2 | 1.2 MiB |  |  |
| macro/report | cpython |  | 0.0509 | 0.0506 |  |  |  | 14.8 KiB |  |
| macro/report | go-native |  | 0.0231 | 0.0230 |  |  |  | 8.8 KiB | 85 |
| macro/report | gopher-lua |  | 0.356 | 0.354 |  |  |  | 33.1 KiB | 1291 |
| macro/report | quickjs |  | 0.110 | 0.108 |  |  |  |  |  |
| macro/report | starlark-go |  | 0.174 | 0.174 |  |  |  | 66.2 KiB | 3084 |
| macro/report | ts-native |  | 0.00848 | 0.00840 |  |  |  | 121 B |  |
| macro/report | wasmoon |  | 0.123 | 0.106 |  |  |  |  |  |
| macro/transform | go | 216.8 | 2.047 | 2.039 | 20664 | 99.1 | 6.1 MiB | 15.0 KiB | 109 |
| macro/transform | ts | 650.2 | 8.128 | 7.436 | 20664 | 393.3 | 6.1 MiB | 1003.5 KiB |  |
| macro/transform | zig | 35.3 | 0.451 | 0.450 | 20664 | 21.8 | 6.1 MiB |  |  |
| macro/transform | cpython |  | 0.0415 | 0.0414 |  |  |  | 48.0 KiB |  |
| macro/transform | go-native |  | 0.00220 | 0.00211 |  |  |  | 7.4 KiB | 3 |
| macro/transform | gopher-lua |  | 0.351 | 0.347 |  |  |  | 268.0 KiB | 4538 |
| macro/transform | quickjs |  | 0.138 | 0.136 |  |  |  |  |  |
| macro/transform | starlark-go |  | 0.151 | 0.149 |  |  |  | 168.7 KiB | 328 |
| macro/transform | ts-native |  | 0.00559 | 0.00551 |  |  |  | 13 B |  |
| macro/transform | wasmoon |  | 0.109 | 0.0902 |  |  |  |  |  |
| messaging/joins | go | 312.8 | 34.723 | 33.566 | 127218 | 272.9 | 239.1 KiB | 6.9 MiB | 58563 |
| messaging/joins | ts | 939.6 | 102.997 | 99.048 | 127218 | 809.6 | 239.1 KiB | 5.2 MiB |  |
| messaging/parents | go | 795.9 | 21.072 | 20.853 | 67518 | 312.1 | 93.8 KiB | 3.8 MiB | 37427 |
| messaging/parents | ts | 688.3 | 77.594 | 72.756 | 67518 | 1149.2 | 93.8 KiB | 4.1 MiB |  |
| messaging/sends | go | 290.8 | 20.774 | 20.490 | 67518 | 307.7 | 93.8 KiB | 3.6 MiB | 37425 |
| messaging/sends | ts | 745.2 | 63.666 | 48.998 | 67518 | 943.0 | 93.8 KiB | 5.2 MiB |  |
| messaging/suspend | go | 169.1 | 38.841 | 38.409 | 48018 | 808.9 | 31.3 KiB | 4.1 MiB | 58114 |
| messaging/suspend | ts | 444.2 | 22.239 | 20.475 | 48018 | 463.1 | 31.3 KiB | 2.4 MiB |  |
| messaging/suspend | zig | 20.6 | 3.014 | 3.008 | 48018 | 62.8 | 31.3 KiB |  |  |
| numbers/add | go | 168.9 | 1.784 | 1.778 | 26030 | 68.5 | 31.4 KiB | 7.8 KiB | 118 |
| numbers/add | ts | 531.4 | 4.094 | 3.900 | 26030 | 157.3 | 31.4 KiB | 298.2 KiB |  |
| numbers/add | zig | 21.7 | 0.418 | 0.417 | 26030 | 16.1 | 31.4 KiB |  |  |
| numbers/add | cpython |  | 0.0444 | 0.0442 |  |  |  | 0 B |  |
| numbers/add | go-native |  | 0.00189 | 0.00188 |  |  |  | 8 B | 1 |
| numbers/add | gopher-lua |  | 0.0720 | 0.0716 |  |  |  | 43.9 KiB | 177 |
| numbers/add | quickjs |  | 0.0752 | 0.0732 |  |  |  |  |  |
| numbers/add | starlark-go |  | 0.137 | 0.136 |  |  |  | 15.9 KiB | 2010 |
| numbers/add | ts-native |  | 0.00184 | 0.00183 |  |  |  | 0 B |  |
| numbers/add | wasmoon |  | 0.0268 | 0.0223 |  |  |  |  |  |
| numbers/divide | go | 168.8 | 1.395 | 1.389 | 18031 | 77.3 | 31.4 KiB | 7.3 KiB | 111 |
| numbers/divide | ts | 519.0 | 3.296 | 3.132 | 18031 | 182.8 | 31.4 KiB | 314.1 KiB |  |
| numbers/divide | zig | 22.1 | 0.306 | 0.306 | 18031 | 17.0 | 31.4 KiB |  |  |
| numbers/divide | cpython |  | 0.0326 | 0.0325 |  |  |  | 0 B |  |
| numbers/divide | go-native |  | 0.000957 | 0.000955 |  |  |  | 8 B | 1 |
| numbers/divide | gopher-lua |  | 0.0535 | 0.0531 |  |  |  | 28.3 KiB | 115 |
| numbers/divide | quickjs |  | 0.0613 | 0.0606 |  |  |  |  |  |
| numbers/divide | starlark-go |  | 0.112 | 0.111 |  |  |  | 15.9 KiB | 2010 |
| numbers/divide | ts-native |  | 0.000926 | 0.000923 |  |  |  | 0 B |  |
| numbers/divide | wasmoon |  | 0.0214 | 0.0186 |  |  |  |  |  |
| numbers/multiply | go | 170.1 | 1.149 | 1.144 | 18031 | 63.7 | 31.4 KiB | 7.3 KiB | 111 |
| numbers/multiply | ts | 532.2 | 2.750 | 2.630 | 18031 | 152.5 | 31.4 KiB | 298.5 KiB |  |
| numbers/multiply | zig | 22.4 | 0.252 | 0.252 | 18031 | 14.0 | 31.4 KiB |  |  |
| numbers/multiply | cpython |  | 0.0356 | 0.0355 |  |  |  | 0 B |  |
| numbers/multiply | go-native |  | 0.000957 | 0.000954 |  |  |  | 8 B | 1 |
| numbers/multiply | gopher-lua |  | 0.0502 | 0.0499 |  |  |  | 29.1 KiB | 118 |
| numbers/multiply | quickjs |  | 0.0812 | 0.0762 |  |  |  |  |  |
| numbers/multiply | starlark-go |  | 0.108 | 0.107 |  |  |  | 15.9 KiB | 2010 |
| numbers/multiply | ts-native |  | 0.000926 | 0.000916 |  |  |  | 6 B |  |
| numbers/multiply | wasmoon |  | 0.0223 | 0.0199 |  |  |  |  |  |
| numbers/quantity | go | 198.8 | 1.288 | 1.283 | 14579 | 88.4 | 39.1 KiB | 7.0 KiB | 108 |
| numbers/quantity | ts | 682.3 | 4.099 | 3.670 | 14579 | 281.2 | 39.1 KiB | 436.4 KiB |  |
| numbers/quantity | zig | 27.8 | 0.298 | 0.297 | 14579 | 20.5 | 39.1 KiB |  |  |
| numbers/quantity | cpython |  | 0.0226 | 0.0225 |  |  |  | 0 B |  |
| numbers/quantity | go-native |  | 0.000719 | 0.000718 |  |  |  | 8 B | 1 |
| numbers/quantity | gopher-lua |  | 0.0326 | 0.0322 |  |  |  | 16.5 KiB | 67 |
| numbers/quantity | quickjs |  | 0.0322 | 0.0320 |  |  |  |  |  |
| numbers/quantity | starlark-go |  | 0.0708 | 0.0705 |  |  |  | 8.1 KiB | 1009 |
| numbers/quantity | ts-native |  | 0.000600 | 0.000595 |  |  |  | 0 B |  |
| numbers/quantity | wasmoon |  | 0.0144 | 0.0131 |  |  |  |  |  |
| text/build | go | 157.8 | 0.754 | 0.752 | 28928 | 26.1 | 374.8 KiB | 6.6 KiB | 104 |
| text/build | ts | 385.8 | 2.047 | 1.920 | 28928 | 70.8 | 374.8 KiB | 193.8 KiB |  |
| text/build | zig | 19.4 | 0.152 | 0.152 | 28928 | 5.3 | 374.8 KiB |  |  |
| text/build | cpython |  | 0.0191 | 0.0191 |  |  |  | 1.5 KiB |  |
| text/build | go-native |  | 0.119 | 0.115 |  |  |  | 387.1 KiB | 500 |
| text/build | gopher-lua |  | 0.196 | 0.174 |  |  |  | 400.8 KiB | 1024 |
| text/build | quickjs |  | 0.0538 | 0.0505 |  |  |  |  |  |
| text/build | starlark-go |  | 0.167 | 0.166 |  |  |  | 395.1 KiB | 1006 |
| text/build | ts-native |  | 0.00171 | 0.00164 |  |  |  | 96 B |  |
| text/build | wasmoon |  | 0.0932 | 0.0888 |  |  |  |  |  |
| text/graphemes | go | 177.3 | 7.092 | 7.055 | 43518 | 163.0 | 144.1 KiB | 8.3 KiB | 122 |
| text/graphemes | ts | 479.2 | 24.821 | 22.201 | 43518 | 570.4 | 144.1 KiB | 2.6 MiB |  |
| text/graphemes | zig | 24.4 | 1.826 | 1.818 | 43518 | 42.0 | 144.1 KiB |  |  |
| text/index | go | 186.1 | 4.095 | 4.075 | 26640 | 153.7 | 49.9 KiB | 7.4 KiB | 113 |
| text/index | ts | 510.2 | 5.850 | 5.620 | 26640 | 219.6 | 49.9 KiB | 412.5 KiB |  |
| text/index | zig | 27.9 | 1.112 | 1.108 | 26640 | 41.7 | 49.9 KiB |  |  |
| text/index | cpython |  | 0.0365 | 0.0364 |  |  |  | 0 B |  |
| text/index | go-native |  | 0.00113 | 0.00113 |  |  |  | 0 B | 0 |
| text/index | gopher-lua |  | 0.247 | 0.246 |  |  |  | 29.3 KiB | 1055 |
| text/index | quickjs |  | 0.129 | 0.126 |  |  |  |  |  |
| text/index | starlark-go |  | 0.158 | 0.156 |  |  |  | 15.9 KiB | 1006 |
| text/index | ts-native |  | 0.00151 | 0.00150 |  |  |  | 0 B |  |
| text/index | wasmoon |  | 0.110 | 0.105 |  |  |  |  |  |
| text/iterate | go | 174.5 | 2.821 | 2.807 | 30318 | 93.0 | 93.0 KiB | 7.7 KiB | 116 |
| text/iterate | ts | 419.7 | 7.201 | 5.418 | 30318 | 237.5 | 93.0 KiB | 708.0 KiB |  |
| text/iterate | zig | 23.0 | 0.642 | 0.642 | 30318 | 21.2 | 93.0 KiB |  |  |
| text/iterate | cpython |  | 0.0497 | 0.0496 |  |  |  | 48 B |  |
| text/iterate | go-native |  | 0.00109 | 0.00109 |  |  |  | 8 B | 1 |
| text/iterate | gopher-lua |  | 0.463 | 0.458 |  |  |  | 187.3 KiB | 9847 |
| text/iterate | quickjs |  | 0.160 | 0.154 |  |  |  |  |  |
| text/iterate | starlark-go |  | 0.346 | 0.344 |  |  |  | 62.0 KiB | 3607 |
| text/iterate | ts-native |  | 0.00237 | 0.00236 |  |  |  | 0 B |  |
| text/iterate | wasmoon |  | 0.139 | 0.130 |  |  |  |  |  |
| text/patterns | go | 185.6 | 4.512 | 4.490 | 13818 | 326.6 | 225.9 KiB | 6.7 KiB | 104 |
| text/patterns | ts | 569.2 | 14.649 | 13.382 | 13818 | 1060.2 | 225.9 KiB | 1.1 MiB |  |
| text/patterns | zig | 24.7 | 1.620 | 1.610 | 13818 | 117.2 | 225.9 KiB |  |  |
| text/patterns | cpython |  | 0.131 | 0.131 |  |  |  | 1.2 KiB |  |
| text/patterns | go-native |  | 0.173 | 0.171 |  |  |  | 37.7 KiB | 1201 |
| text/patterns | gopher-lua |  | 0.722 | 0.720 |  |  |  | 390.8 KiB | 17736 |
| text/patterns | quickjs |  | 0.622 | 0.606 |  |  |  |  |  |
| text/patterns | starlark-go |  | 0.517 | 0.513 |  |  |  | 87.0 KiB | 4507 |
| text/patterns | ts-native |  | 0.0356 | 0.0353 |  |  |  | 870 B |  |
| text/patterns | wasmoon |  | 0.179 | 0.173 |  |  |  |  |  |

## Payload

What a browser Host ships to embed each Core: bundled with `Bun.build --target browser --minify`, compressed with `node:zlib`.

| Payload | Brotli | gzip -9 | Raw |
| - | -: | -: | -: |
| TS Core: Example Host | 150.6 KiB | 177.3 KiB | 609.9 KiB |
| TS Core: @northtalk/ts | 150.1 KiB | 176.6 KiB | 608.4 KiB |
| Zig Core: Example Host + talk.wasm | 857.9 KiB | 1.2 MiB | 3.7 MiB |
| Zig ÷ TS Example Host | 5.7× | 7.0× | 6.2× |

## Fuel parity

Every Benchmark used the same Fuel on each Core.

## Cost Model outliers

Benchmarks whose ns/Fuel is more than 3× their runner's median. These are advisory: any reweighting goes through the Spec.

- core/fib@slice=10 on zig: 78.8 ns/Fuel, 3.8× the median
- text/patterns on zig: 117.2 ns/Fuel, 5.7× the median
- host/pump on zig: 477.4 ns/Fuel, 23.0× the median
- messaging/suspend on zig: 62.8 ns/Fuel, 3.0× the median
- lifecycle/load-small on zig: 469.8 ns/Fuel, 22.6× the median
- text/patterns on ts: 1060.2 ns/Fuel, 3.9× the median
- host/suspending on ts: 1666.5 ns/Fuel, 6.1× the median
- host/conversion on ts: 1270.9 ns/Fuel, 4.7× the median
- host/pump on ts: 3364.3 ns/Fuel, 12.3× the median
- messaging/sends on ts: 943.0 ns/Fuel, 3.5× the median
- messaging/parents on ts: 1149.2 ns/Fuel, 4.2× the median
- lifecycle/load-small on ts: 2355.8 ns/Fuel, 8.6× the median
- lifecycle/rollback on ts: 2269.6 ns/Fuel, 8.3× the median
- core/fib@slice=10 on go: 1295.8 ns/Fuel, 8.3× the median
- host/immediate on go: 534.9 ns/Fuel, 3.4× the median
- host/suspending on go: 2218.2 ns/Fuel, 14.3× the median
- host/properties on go: 603.0 ns/Fuel, 3.9× the median
- host/conversion on go: 972.3 ns/Fuel, 6.2× the median
- host/pump on go: 6928.0 ns/Fuel, 44.5× the median
- messaging/suspend on go: 808.9 ns/Fuel, 5.2× the median
- lifecycle/load-small on go: 6898.8 ns/Fuel, 44.3× the median
- lifecycle/rollback on go: 2111.8 ns/Fuel, 13.6× the median

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
