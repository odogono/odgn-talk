# Message Layer from an Elixir Host

Measured for [#553](https://github.com/odogono/odgn-talk/issues/553), part of [#532](https://github.com/odogono/odgn-talk/issues/532), against [its thresholds](https://github.com/odogono/odgn-talk/issues/532#issuecomment-6095554407), by [`bench/message-layer/elixir`](../message-layer/elixir/). [#554](https://github.com/odogono/odgn-talk/issues/554) decides what they mean for a third Core.

| | |
| --- | --- |
| Commit | `2605c656` |
| Machine | Apple M5, macOS 27.0.1, load average 2.09 1.34 1.12 at the start |
| Elixir | 1.20.4, OTP 29 |
| Wasmex | 0.15.1 (wasmtime 47.0.2), Cranelift `opt_level: :speed` |
| Go | go1.27.2 |
| Docker | 29.8.0 Docker Desktop cgroup v2 |
| Reactor | `ac9e2a5e127afc5f858452e551e13e9b0dbabd9dd2cbd796b6b9ff247a4c3c84` |
| Samples | 5000 per latency run after 500 warm-up, 3 runs judged on the median run; 5000 instantiations; 20 instances for memory; 20 repetitions per fault; 2000 mutated sources |

## Verdict

**wasmex: meets every row**

| Row | Measured | Threshold | | Note |
| --- | --- | --- | --- | --- |
| Capability call p50 | 96.1 µs | ≤ 500.0 µs | pass | p99 323.5 µs |
| Pump p50 | 178.3 µs | ≤ 250.0 µs | pass | p99 519.0 µs |
| Instantiation p50 | 1.19 ms | ≤ 50.0 ms | pass | p99 1.89 ms |
| Memory per instance (median) | 15.5 MiB | ≤ 16.0 MiB | pass |  |
| Payload, Brotli | 2.0 MiB | ≤ 3.0 MiB | pass |  |
| Payload, raw | 12.1 MiB | ≤ 25.0 MiB | pass |  |
| Memory containment, default limits under 128.0 MiB | every Run ended in a Limit Fault | Limit Fault, never out of memory | pass |  |
| Memory containment, conformance minimum limits under 1024.0 MiB | every Run ended in a Limit Fault | Limit Fault, never out of memory | pass |  |
| Script faults | no instance lost | no trap and no lost instance | pass |  |

**sidecar: meets every row**

| Row | Measured | Threshold | | Note |
| --- | --- | --- | --- | --- |
| Capability call p50 | 25.0 µs | ≤ 100.0 µs | pass | p99 37.8 µs |
| Pump p50 | 43.1 µs | ≤ 100.0 µs | pass | p99 66.7 µs |
| Instantiation p50 | 4.33 ms | ≤ 100.0 ms | pass | p99 5.41 ms |
| Memory per instance (median) | 18.3 MiB | ≤ 32.0 MiB | pass |  |
| Memory containment, default limits under 128.0 MiB | every Run ended in a Limit Fault | Limit Fault, never out of memory | pass |  |
| Memory containment, conformance minimum limits under 1024.0 MiB | every Run ended in a Limit Fault | Limit Fault, never out of memory | pass |  |
| Script faults | no instance lost | no trap and no lost instance | pass |  |

**c, wasmtime: meets every row judged here (containment and faults)**

| Row | Measured | Threshold | | Note |
| --- | --- | --- | --- | --- |
| Memory containment, default limits under 128.0 MiB | every Run ended in a Limit Fault | Limit Fault, never out of memory | pass |  |
| Memory containment, conformance minimum limits under 1024.0 MiB | every Run ended in a Limit Fault | Limit Fault, never out of memory | pass |  |
| Script faults | no instance lost | no trap and no lost instance | pass |  |


## Latency

A Capability call is the time from the Host receiving one `op` need to receiving the next, inside one Pump of 100 calls. The handler answers at once with its argument, `{items: [i, "hello", true], count: 1}`. A Pump is a `deliver` and a `pump` of an empty Handler. Instantiation runs from a compiled module (Wasmex) or process spawn (sidecar) to the `hello` reply.

| Transport | Figure | p50 | p99 | mean | min | max | n | p50 of each run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sidecar | Capability call | 25.0 µs | 37.8 µs | 25.4 µs | 17.4 µs | 166.2 µs | 5049 | 25.0 µs, 25.0 µs, 25.1 µs |
| sidecar | Pump | 43.1 µs | 66.7 µs | 44.0 µs | 33.2 µs | 249.1 µs | 5000 | 43.1 µs, 43.2 µs, 43.1 µs |
| sidecar | Instantiation | 4.33 ms | 5.41 ms | 4.37 ms | 4.0 ms | 15.1 ms | 5000 | 4.3 ms, 4.33 ms, 4.34 ms |
| wasmex | Capability call | 96.1 µs | 323.5 µs | 104.7 µs | 80.8 µs | 791.1 µs | 5049 | 96.2 µs, 95.7 µs, 96.1 µs |
| wasmex | Pump | 178.3 µs | 519.0 µs | 188.6 µs | 152.3 µs | 889.3 µs | 5000 | 178.3 µs, 178.0 µs, 179.0 µs |
| wasmex | Instantiation | 1.19 ms | 1.89 ms | 1.22 ms | 1.08 ms | 2.89 ms | 5000 | 1.2 ms, 1.19 ms, 1.19 ms |
| wasmex, opt-level none | Capability call | 105.0 µs | 397.8 µs | 129.6 µs | 86.3 µs | 970.9 µs | 5049 | 119.2 µs, 105.0 µs, 104.5 µs |
| wasmex, opt-level none | Pump | 196.0 µs | 669.5 µs | 257.1 µs | 161.4 µs | 1.2 ms | 5000 | 196.0 µs, 219.4 µs, 195.7 µs |
| wasmex, opt-level none | Instantiation | 1.48 ms | 2.85 ms | 1.54 ms | 1.28 ms | 5.57 ms | 5000 | 1.38 ms, 1.48 ms, 1.49 ms |

Compiling the module, once per Engine: 793.3 ms at `none`, 963.3 ms at `speed`.

### Memory per instance

Linear memory for Wasmex, RSS for the sidecar, after `hello`, a `new-group`, loading a small Script and one Pump.

| Transport | median | max | instances |
| --- | --- | --- | --- |
| sidecar | 18.3 MiB | 19.0 MiB | 20 |
| wasmex | 15.5 MiB | 15.5 MiB | 20 |
| wasmex, opt-level none | 15.5 MiB | 15.5 MiB | 20 |

## Memory containment

Each Script runs on a fresh instance. Without a cap, the memory observed is what the Script reached before its Limit Faults. Linear memory never shrinks, so for Wasmex it is the peak.

| Transport | Limits | Cap | Script | Outcomes | Observed |
| --- | --- | --- | --- | --- | --- |
| c, wasmtime | default limits | none | a growing List | limit fault: alloc: 20 | linear memory 46.0 MiB |
| c, wasmtime | default limits | none | doubling text | limit fault: alloc: 20 | linear memory 55.0 MiB |
| c, wasmtime | default limits | none | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | linear memory 33.5 MiB |
| c, wasmtime | default limits | 128.0 MiB | a growing List | limit fault: alloc: 20 | linear memory 46.5 MiB |
| c, wasmtime | default limits | 128.0 MiB | doubling text | limit fault: alloc: 20 | linear memory 55.0 MiB |
| c, wasmtime | default limits | 128.0 MiB | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | linear memory 34.5 MiB |
| c, wasmtime | conformance minimum limits | none | a growing List | limit fault: alloc: 20 | linear memory 345.5 MiB |
| c, wasmtime | conformance minimum limits | none | doubling text | limit fault: alloc: 20 | linear memory 624.5 MiB |
| c, wasmtime | conformance minimum limits | none | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | linear memory 1250.9 MiB |
| c, wasmtime | conformance minimum limits | 1024.0 MiB | a growing List | limit fault: alloc: 20 | linear memory 345.0 MiB |
| c, wasmtime | conformance minimum limits | 1024.0 MiB | doubling text | limit fault: alloc: 20 | linear memory 625.0 MiB |
| c, wasmtime | conformance minimum limits | 1024.0 MiB | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | linear memory 613.5 MiB |
| sidecar | default limits | none | a growing List | limit fault: alloc: 20 | cgroup peak 56.3 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | none | doubling text | limit fault: alloc: 20 | cgroup peak 65.7 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | none | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | cgroup peak 46.6 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | 128.0 MiB | a growing List | limit fault: alloc: 20 | cgroup peak 55.5 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | 128.0 MiB | doubling text | limit fault: alloc: 20 | cgroup peak 65.9 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | 128.0 MiB | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | cgroup peak 48.2 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | none | a growing List | limit fault: alloc: 20 | cgroup peak 441.9 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | none | doubling text | limit fault: alloc: 20 | cgroup peak 511.3 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | none | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | cgroup peak 574.9 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | 1024.0 MiB | a growing List | limit fault: alloc: 20 | cgroup peak 458.5 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | 1024.0 MiB | doubling text | limit fault: alloc: 20 | cgroup peak 513.0 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | 1024.0 MiB | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | cgroup peak 572.5 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| wasmex | default limits | none | a growing List | limit fault: alloc: 20 | linear memory 46.5 MiB |
| wasmex | default limits | none | doubling text | limit fault: alloc: 20 | linear memory 55.0 MiB |
| wasmex | default limits | none | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | linear memory 34.5 MiB |
| wasmex | default limits | 128.0 MiB | a growing List | limit fault: alloc: 20 | linear memory 46.0 MiB |
| wasmex | default limits | 128.0 MiB | doubling text | limit fault: alloc: 20 | linear memory 55.5 MiB |
| wasmex | default limits | 128.0 MiB | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | linear memory 34.0 MiB |
| wasmex | conformance minimum limits | none | a growing List | limit fault: alloc: 20 | linear memory 345.5 MiB |
| wasmex | conformance minimum limits | none | doubling text | limit fault: alloc: 20 | linear memory 624.5 MiB |
| wasmex | conformance minimum limits | none | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | linear memory 1251.4 MiB |
| wasmex | conformance minimum limits | 1024.0 MiB | a growing List | limit fault: alloc: 20 | linear memory 343.5 MiB |
| wasmex | conformance minimum limits | 1024.0 MiB | doubling text | limit fault: alloc: 20 | linear memory 624.5 MiB |
| wasmex | conformance minimum limits | 1024.0 MiB | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | linear memory 613.0 MiB |

## Script faults: c, wasmtime

| Case | Outcomes | Lost | Lost on | Healthy after | Time |
| --- | --- | --- | --- | --- | --- |
| Fuel Limit Fault | limit fault: fuel: 20 | 0 |  | yes | 0.3 s |
| Allocation Limit Fault: a growing List | limit fault: alloc: 20 | 0 |  | yes | 12.4 s |
| Allocation Limit Fault: doubling text | limit fault: alloc: 20 | 0 |  | yes | 0.6 s |
| Persistent State Limit Fault | completed: 11<br>limit fault: persistent: 20 | 0 |  | yes | 0.7 s |
| call depth Limit Fault at the default depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at the conformance minimum depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at a depth of 1,000,000 | load refused: host error invalid value: 20 | 0 |  | yes | 0.0 s |
| mailbox full | mailbox full, then completed: 20 | 0 |  | yes | 0.0 s |
| throw | errored: first: 20 | 0 |  | yes | 0.0 s |
| run-time error | errored: division by zero: 20 | 0 |  | yes | 0.0 s |
| Operation failure | errored: refused: 20 | 0 |  | yes | 0.0 s |
| Host error from an Operation | errored: host error: 20 | 0 |  | yes | 0.0 s |
| hostile Script source: pathological | load refused: load error: 34<br>loaded: 3<br>loaded and ran: 7 | 0 |  | yes | 22.4 s |
| hostile Script source: mutated corpus | load refused: load error: 1920<br>loaded: 9<br>loaded and ran: 71 | 0 |  | yes | 0.4 s |
| malformed frames | host error: 10<br>ok: 4<br>protocol error: 21<br>refused by the transport: null_buffer: 2 | 0 |  | yes | 0.4 s |


## Script faults: sidecar

| Case | Outcomes | Lost | Lost on | Healthy after | Time |
| --- | --- | --- | --- | --- | --- |
| Fuel Limit Fault | limit fault: fuel: 20 | 0 |  | yes | 0.1 s |
| Allocation Limit Fault: a growing List | limit fault: alloc: 20 | 0 |  | yes | 2.8 s |
| Allocation Limit Fault: doubling text | limit fault: alloc: 20 | 0 |  | yes | 0.2 s |
| Persistent State Limit Fault | completed: 11<br>limit fault: persistent: 20 | 0 |  | yes | 0.2 s |
| call depth Limit Fault at the default depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at the conformance minimum depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at a depth of 1,000,000 | load refused: host error invalid value: 20 | 0 |  | yes | 0.0 s |
| mailbox full | mailbox full, then completed: 20 | 0 |  | yes | 0.0 s |
| throw | errored: first: 20 | 0 |  | yes | 0.0 s |
| run-time error | errored: division by zero: 20 | 0 |  | yes | 0.0 s |
| Operation failure | errored: refused: 20 | 0 |  | yes | 0.0 s |
| Host error from an Operation | errored: host error: 20 | 0 |  | yes | 0.0 s |
| hostile Script source: pathological | load refused: load error: 34<br>loaded: 3<br>loaded and ran: 7 | 0 |  | yes | 21.2 s |
| hostile Script source: mutated corpus | load refused: load error: 1920<br>loaded: 9<br>loaded and ran: 71 | 0 |  | yes | 0.4 s |
| malformed frames | host error: 10<br>ok: 4<br>protocol error: 23 | 0 |  | yes | 0.4 s |


## Script faults: wasmex

| Case | Outcomes | Lost | Lost on | Healthy after | Time |
| --- | --- | --- | --- | --- | --- |
| Fuel Limit Fault | limit fault: fuel: 20 | 0 |  | yes | 0.3 s |
| Allocation Limit Fault: a growing List | limit fault: alloc: 20 | 0 |  | yes | 13.9 s |
| Allocation Limit Fault: doubling text | limit fault: alloc: 20 | 0 |  | yes | 0.5 s |
| Persistent State Limit Fault | completed: 11<br>limit fault: persistent: 20 | 0 |  | yes | 0.8 s |
| call depth Limit Fault at the default depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at the conformance minimum depth | limit fault: depth: 20 | 0 |  | yes | 0.1 s |
| deep recursion at a depth of 1,000,000 | load refused: host error invalid value: 20 | 0 |  | yes | 0.0 s |
| mailbox full | mailbox full, then completed: 20 | 0 |  | yes | 0.0 s |
| throw | errored: first: 20 | 0 |  | yes | 0.0 s |
| run-time error | errored: division by zero: 20 | 0 |  | yes | 0.0 s |
| Operation failure | errored: refused: 20 | 0 |  | yes | 0.0 s |
| Host error from an Operation | errored: host error: 20 | 0 |  | yes | 0.0 s |
| hostile Script source: pathological | load refused: load error: 34<br>loaded: 3<br>loaded and ran: 7 | 0 |  | yes | 19.7 s |
| hostile Script source: mutated corpus | load refused: load error: 1920<br>loaded: 9<br>loaded and ran: 71 | 0 |  | yes | 0.6 s |
| malformed frames | host error: 10<br>ok: 4<br>protocol error: 21<br>refused by the transport: null_buffer: 2 | 0 |  | yes | 0.4 s |
| talk_send past the talk_buffer allocation | protocol error: 1 | 0 |  | yes | 0.0 s |

