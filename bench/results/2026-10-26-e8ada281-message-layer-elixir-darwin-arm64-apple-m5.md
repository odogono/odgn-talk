# Message Layer from an Elixir Host

Measured for [#553](https://github.com/odogono/odgn-talk/issues/553), part of [#532](https://github.com/odogono/odgn-talk/issues/532), against [its thresholds](https://github.com/odogono/odgn-talk/issues/532#issuecomment-6095554407), by [`bench/message-layer/elixir`](../message-layer/elixir/). [#554](https://github.com/odogono/odgn-talk/issues/554) decides what they mean for a third Core.

| | |
| --- | --- |
| Commit | `e8ada281` |
| Machine | Apple M5, macOS 27.0.1, load average 2.49 2.26 2.02 at the start |
| Elixir | 1.20.4, OTP 29 |
| Wasmex | 0.15.1 (wasmtime 47.0.2), Cranelift `opt_level: :speed` |
| Zig toolchain | 0.17.0 |
| Docker | 29.8.0 Docker Desktop cgroup v2 |
| Reactor | `a891acc9f0984e6def63703d07ae80b45cb5fb776bd1a11f2d03165e92df4a17` |
| Native sidecar | `f8bd61dd1878f6f703ac6ba8348595afc277960651bbd6a361f23c66f121ab33` |
| Samples | 5000 per latency run after 500 warm-up, 3 runs judged on the median run; 5000 instantiations; 20 instances for memory; 20 repetitions per fault; 2000 mutated sources |

## Verdict

**wasmex: meets every row**

| Row | Measured | Threshold | | Note |
| --- | --- | --- | --- | --- |
| Capability call p50 | 55.4 µs | ≤ 500.0 µs | pass | p99 67.0 µs |
| Pump p50 | 102.9 µs | ≤ 250.0 µs | pass | p99 191.3 µs |
| Instantiation p50 | 1.39 ms | ≤ 50.0 ms | pass | p99 1.57 ms |
| Memory per instance (median) | 2.0 MiB | ≤ 16.0 MiB | pass |  |
| Payload, Brotli | 0.8 MiB | ≤ 3.0 MiB | pass |  |
| Payload, raw | 3.4 MiB | ≤ 25.0 MiB | pass |  |

**sidecar: meets every row**

| Row | Measured | Threshold | | Note |
| --- | --- | --- | --- | --- |
| Capability call p50 | 12.3 µs | ≤ 100.0 µs | pass | p99 18.5 µs |
| Pump p50 | 18.4 µs | ≤ 100.0 µs | pass | p99 27.0 µs |
| Instantiation p50 | 3.66 ms | ≤ 100.0 ms | pass | p99 4.3 ms |
| Memory per instance (median) | 4.1 MiB | ≤ 32.0 MiB | pass |  |


## Latency

A Capability call is the time from the Host receiving one `op` need to receiving the next, inside one Pump of 100 calls. The handler answers at once with its argument, `{items: [i, "hello", true], count: 1}`. A Pump is a `deliver` and a `pump` of an empty Handler. Instantiation runs from a compiled module (Wasmex) or process spawn (sidecar) to the `hello` reply.

| Transport | Figure | p50 | p99 | mean | min | max | n | p50 of each run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sidecar | Capability call | 12.3 µs | 18.5 µs | 12.7 µs | 9.5 µs | 28.7 µs | 5049 | 12.4 µs, 12.3 µs, 11.5 µs |
| sidecar | Pump | 18.4 µs | 27.0 µs | 19.3 µs | 15.4 µs | 43.2 µs | 5000 | 18.4 µs, 19.0 µs, 18.3 µs |
| sidecar | Instantiation | 3.66 ms | 4.3 ms | 3.69 ms | 3.38 ms | 7.69 ms | 5000 | 3.63 ms, 3.66 ms, 3.69 ms |
| wasmex | Capability call | 55.4 µs | 67.0 µs | 54.4 µs | 39.5 µs | 150.2 µs | 5049 | 55.4 µs, 54.7 µs, 57.4 µs |
| wasmex | Pump | 102.9 µs | 191.3 µs | 105.7 µs | 72.6 µs | 273.0 µs | 5000 | 124.9 µs, 102.9 µs, 100.5 µs |
| wasmex | Instantiation | 1.39 ms | 1.57 ms | 1.4 ms | 1.35 ms | 2.42 ms | 5000 | 1.39 ms, 1.38 ms, 1.39 ms |
| wasmex, opt-level none | Capability call | 65.6 µs | 251.3 µs | 89.5 µs | 36.8 µs | 271.4 µs | 5049 | 63.5 µs, 65.9 µs, 65.6 µs |
| wasmex, opt-level none | Pump | 128.4 µs | 428.0 µs | 174.0 µs | 83.8 µs | 483.7 µs | 5000 | 128.8 µs, 128.4 µs, 128.4 µs |
| wasmex, opt-level none | Instantiation | 2.64 ms | 3.22 ms | 2.67 ms | 2.47 ms | 6.34 ms | 5000 | 2.64 ms, 2.65 ms, 1.6 ms |

Compiling the module, once per Engine: 277.8 ms at `none`, 319.9 ms at `speed`.

### Memory per instance

Linear memory for Wasmex, RSS for the sidecar, after `hello`, a `new-group`, loading a small Script and one Pump.

| Transport | median | max | instances |
| --- | --- | --- | --- |
| sidecar | 4.1 MiB | 4.1 MiB | 20 |
| wasmex | 2.0 MiB | 2.0 MiB | 20 |
| wasmex, opt-level none | 2.0 MiB | 2.0 MiB | 20 |

## Property crossings

For [#1572](https://github.com/odogono/odgn-talk/issues/1572). A property get and a collection `at` are the time from the Host receiving one `prop` need to receiving the next, inside one Pump of 100, answered at once. A query is a whole `deliver` and `pump` of `the value of element i of p` for every member, resolved by the Core: one `count`, then an `at` and a `get` per member.

| Transport | Figure | p50 | p99 | mean | min | max | n | p50 of each run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sidecar | Property get | 10.1 µs | 15.7 µs | 10.1 µs | 6.6 µs | 22.1 µs | 5049 | 9.9 µs, 10.1 µs, 10.5 µs |
| sidecar | Collection `at` | 9.8 µs | 15.1 µs | 9.8 µs | 7.1 µs | 25.8 µs | 5049 | 9.9 µs, 9.8 µs, 9.8 µs |
| sidecar | Query, 10 members (21 needs) | 236.1 µs | 257.5 µs | 236.4 µs | 215.5 µs | 285.8 µs | 200 | 236.1 µs, 233.2 µs, 237.6 µs |
| sidecar | Query, 216 members (433 needs) | 4.42 ms | 4.65 ms | 4.43 ms | 4.16 ms | 4.75 ms | 200 | 4.42 ms, 4.42 ms, 4.4 ms |
| sidecar | Query, 1000 members (2001 needs) | 22.01 ms | 28.53 ms | 22.25 ms | 20.84 ms | 36.17 ms | 200 | 21.84 ms, 22.01 ms, 22.08 ms |
| wasmex | Property get | 42.0 µs | 120.5 µs | 47.3 µs | 31.1 µs | 208.2 µs | 5049 | 52.1 µs, 42.0 µs, 41.5 µs |
| wasmex | Collection `at` | 42.2 µs | 108.5 µs | 45.3 µs | 34.5 µs | 243.3 µs | 5049 | 42.5 µs, 42.2 µs, 41.8 µs |
| wasmex | Query, 10 members (21 needs) | 1.03 ms | 1.46 ms | 1.04 ms | 908.2 µs | 1.57 ms | 200 | 1.03 ms, 1.02 ms, 1.28 ms |
| wasmex | Query, 216 members (433 needs) | 21.8 ms | 36.11 ms | 23.73 ms | 18.9 ms | 37.42 ms | 200 | 21.8 ms, 21.77 ms, 21.82 ms |
| wasmex | Query, 1000 members (2001 needs) | 103.31 ms | 114.41 ms | 102.27 ms | 88.87 ms | 120.12 ms | 200 | 103.31 ms, 122.61 ms, 102.25 ms |

