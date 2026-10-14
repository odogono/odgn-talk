# Message Layer from an Elixir Host

Measured for [#553](https://github.com/odogono/odgn-talk/issues/553), part of [#532](https://github.com/odogono/odgn-talk/issues/532), against [its thresholds](https://github.com/odogono/odgn-talk/issues/532#issuecomment-6095554407), by [`bench/message-layer/elixir`](../message-layer/elixir/). [#554](https://github.com/odogono/odgn-talk/issues/554) decides what they mean for a third Core.

| | |
| --- | --- |
| Commit | `fd2f13be` |
| Machine | Apple M5, macOS 27.0.1, load average 3.99 4.66 3.26 at the start |
| Elixir | 1.20.4, OTP 29 |
| Wasmex | 0.15.1 (wasmtime 47.0.2), Cranelift `opt_level: :speed` |
| Go | go1.27.2 |
| Docker | 29.8.0 Docker Desktop cgroup v2 |
| Reactor | `9851b3976cfdd0b8d6d0788b124b3acc1cc850e9151ce5275a850b94c0cca1b3` |
| Samples | 5000 per latency run after 500 warm-up, 3 runs judged on the median run; 5000 instantiations; 20 instances for memory; 20 repetitions per fault; 2000 mutated sources |

## Verdict

**wasmex: meets every row**

| Row | Measured | Threshold | | Note |
| --- | --- | --- | --- | --- |
| Capability call p50 | 99.1 µs | ≤ 500.0 µs | pass | p99 344.4 µs |
| Pump p50 | 176.5 µs | ≤ 250.0 µs | pass | p99 545.9 µs |
| Instantiation p50 | 1.26 ms | ≤ 50.0 ms | pass | p99 2.14 ms |
| Memory per instance (median) | 15.8 MiB | ≤ 16.0 MiB | pass |  |
| Payload, Brotli | 2.1 MiB | ≤ 3.0 MiB | pass |  |
| Payload, raw | 12.5 MiB | ≤ 25.0 MiB | pass |  |
| Memory containment, default limits under 128.0 MiB | every Run ended in a Limit Fault | Limit Fault, never out of memory | pass |  |
| Memory containment, conformance minimum limits under 1024.0 MiB | every Run ended in a Limit Fault | Limit Fault, never out of memory | pass |  |
| Script faults | no instance lost | no trap and no lost instance | pass |  |

**sidecar: meets every row**

| Row | Measured | Threshold | | Note |
| --- | --- | --- | --- | --- |
| Capability call p50 | 25.0 µs | ≤ 100.0 µs | pass | p99 48.8 µs |
| Pump p50 | 39.9 µs | ≤ 100.0 µs | pass | p99 77.9 µs |
| Instantiation p50 | 4.53 ms | ≤ 100.0 ms | pass | p99 6.67 ms |
| Memory per instance (median) | 18.4 MiB | ≤ 32.0 MiB | pass |  |
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
| sidecar | Capability call | 25.0 µs | 48.8 µs | 25.5 µs | 17.5 µs | 187.0 µs | 5049 | 24.9 µs, 25.0 µs, 25.0 µs |
| sidecar | Pump | 39.9 µs | 77.9 µs | 41.2 µs | 31.5 µs | 222.3 µs | 5000 | 39.3 µs, 39.9 µs, 40.3 µs |
| sidecar | Instantiation | 4.53 ms | 6.67 ms | 4.66 ms | 4.15 ms | 17.78 ms | 5000 | 4.53 ms, 4.52 ms, 5.03 ms |
| wasmex | Capability call | 99.1 µs | 344.4 µs | 107.8 µs | 83.1 µs | 845.8 µs | 5049 | 99.1 µs, 98.5 µs, 99.2 µs |
| wasmex | Pump | 176.5 µs | 545.9 µs | 189.5 µs | 149.7 µs | 922.6 µs | 5000 | 176.5 µs, 176.1 µs, 176.6 µs |
| wasmex | Instantiation | 1.26 ms | 2.14 ms | 1.3 ms | 1.14 ms | 4.35 ms | 5000 | 1.24 ms, 1.26 ms, 1.26 ms |
| wasmex, opt-level none | Capability call | 110.3 µs | 1.52 ms | 208.5 µs | 80.6 µs | 15.42 ms | 5049 | 127.2 µs, 105.2 µs, 110.3 µs |
| wasmex, opt-level none | Pump | 194.5 µs | 761.3 µs | 265.0 µs | 153.6 µs | 1.23 ms | 5000 | 194.5 µs, 195.1 µs, 193.9 µs |
| wasmex, opt-level none | Instantiation | 1.44 ms | 4.52 ms | 1.63 ms | 1.28 ms | 12.48 ms | 5000 | 1.44 ms, 2.18 ms, 1.41 ms |

Compiling the module, once per Engine: 1080.4 ms at `none`, 1122.5 ms at `speed`.

### Memory per instance

Linear memory for Wasmex, RSS for the sidecar, after `hello`, a `new-group`, loading a small Script and one Pump.

| Transport | median | max | instances |
| --- | --- | --- | --- |
| sidecar | 18.4 MiB | 19.1 MiB | 20 |
| wasmex | 15.8 MiB | 15.8 MiB | 20 |
| wasmex, opt-level none | 15.8 MiB | 15.8 MiB | 20 |

## Memory containment

Each Script runs on a fresh instance. Without a cap, the memory observed is what the Script reached before its Limit Faults. Linear memory never shrinks, so for Wasmex it is the peak.

| Transport | Limits | Cap | Script | Outcomes | Observed |
| --- | --- | --- | --- | --- | --- |
| c, wasmtime | default limits | none | a growing List | limit fault: alloc: 20 | linear memory 39.0 MiB |
| c, wasmtime | default limits | none | doubling text | limit fault: alloc: 20 | linear memory 55.0 MiB |
| c, wasmtime | default limits | none | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | linear memory 31.5 MiB |
| c, wasmtime | default limits | 128.0 MiB | a growing List | limit fault: alloc: 20 | linear memory 39.0 MiB |
| c, wasmtime | default limits | 128.0 MiB | doubling text | limit fault: alloc: 20 | linear memory 55.0 MiB |
| c, wasmtime | default limits | 128.0 MiB | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | linear memory 31.5 MiB |
| c, wasmtime | conformance minimum limits | none | a growing List | limit fault: alloc: 20 | linear memory 275.0 MiB |
| c, wasmtime | conformance minimum limits | none | doubling text | limit fault: alloc: 20 | linear memory 624.8 MiB |
| c, wasmtime | conformance minimum limits | none | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | linear memory 684.1 MiB |
| c, wasmtime | conformance minimum limits | 1024.0 MiB | a growing List | limit fault: alloc: 20 | linear memory 261.0 MiB |
| c, wasmtime | conformance minimum limits | 1024.0 MiB | doubling text | limit fault: alloc: 20 | linear memory 624.8 MiB |
| c, wasmtime | conformance minimum limits | 1024.0 MiB | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | linear memory 570.5 MiB |
| sidecar | default limits | none | a growing List | limit fault: alloc: 20 | cgroup peak 56.8 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | none | doubling text | limit fault: alloc: 20 | cgroup peak 66.0 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | none | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | cgroup peak 45.5 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | 128.0 MiB | a growing List | limit fault: alloc: 20 | cgroup peak 52.5 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | 128.0 MiB | doubling text | limit fault: alloc: 20 | cgroup peak 56.1 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | 128.0 MiB | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | cgroup peak 47.3 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | none | a growing List | limit fault: alloc: 20 | cgroup peak 256.4 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | none | doubling text | limit fault: alloc: 20 | cgroup peak 635.1 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | none | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | cgroup peak 416.4 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | 1024.0 MiB | a growing List | limit fault: alloc: 20 | cgroup peak 282.8 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | 1024.0 MiB | doubling text | limit fault: alloc: 20 | cgroup peak 511.3 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | 1024.0 MiB | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | cgroup peak 383.6 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| wasmex | default limits | none | a growing List | limit fault: alloc: 20 | linear memory 39.0 MiB |
| wasmex | default limits | none | doubling text | limit fault: alloc: 20 | linear memory 55.0 MiB |
| wasmex | default limits | none | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | linear memory 31.5 MiB |
| wasmex | default limits | 128.0 MiB | a growing List | limit fault: alloc: 20 | linear memory 39.0 MiB |
| wasmex | default limits | 128.0 MiB | doubling text | limit fault: alloc: 20 | linear memory 55.0 MiB |
| wasmex | default limits | 128.0 MiB | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | linear memory 31.5 MiB |
| wasmex | conformance minimum limits | none | a growing List | limit fault: alloc: 20 | linear memory 239.0 MiB |
| wasmex | conformance minimum limits | none | doubling text | limit fault: alloc: 20 | linear memory 624.8 MiB |
| wasmex | conformance minimum limits | none | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | linear memory 684.1 MiB |
| wasmex | conformance minimum limits | 1024.0 MiB | a growing List | limit fault: alloc: 20 | linear memory 261.5 MiB |
| wasmex | conformance minimum limits | 1024.0 MiB | doubling text | limit fault: alloc: 20 | linear memory 624.8 MiB |
| wasmex | conformance minimum limits | 1024.0 MiB | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | linear memory 685.1 MiB |

## Script faults: c, wasmtime

| Case | Outcomes | Lost | Lost on | Healthy after | Time |
| --- | --- | --- | --- | --- | --- |
| Fuel Limit Fault | limit fault: fuel: 20 | 0 |  | yes | 0.3 s |
| Allocation Limit Fault: a growing List | limit fault: alloc: 20 | 0 |  | yes | 6.2 s |
| Allocation Limit Fault: doubling text | limit fault: alloc: 20 | 0 |  | yes | 0.6 s |
| Persistent State Limit Fault | completed: 11<br>limit fault: persistent: 20 | 0 |  | yes | 0.6 s |
| call depth Limit Fault at the default depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at the conformance minimum depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at a depth of 1,000,000 | load refused: host error invalid value: 20 | 0 |  | yes | 0.0 s |
| mailbox full | mailbox full, then completed: 20 | 0 |  | yes | 0.0 s |
| throw | errored: first: 20 | 0 |  | yes | 0.0 s |
| run-time error | errored: division by zero: 20 | 0 |  | yes | 0.0 s |
| Operation failure | errored: refused: 20 | 0 |  | yes | 0.0 s |
| Host error from an Operation | errored: host error: 20 | 0 |  | yes | 0.0 s |
| hostile Script source: pathological | load refused: load error: 34<br>loaded: 3<br>loaded and ran: 7 | 0 |  | yes | 22.8 s |
| hostile Script source: mutated corpus | load refused: load error: 1933<br>loaded: 8<br>loaded and ran: 59 | 0 |  | yes | 0.4 s |
| malformed frames | host error: 10<br>ok: 4<br>protocol error: 21<br>refused by the transport: null_buffer: 2 | 0 |  | yes | 0.4 s |


## Script faults: sidecar

| Case | Outcomes | Lost | Lost on | Healthy after | Time |
| --- | --- | --- | --- | --- | --- |
| Fuel Limit Fault | limit fault: fuel: 20 | 0 |  | yes | 0.1 s |
| Allocation Limit Fault: a growing List | limit fault: alloc: 20 | 0 |  | yes | 1.7 s |
| Allocation Limit Fault: doubling text | limit fault: alloc: 20 | 0 |  | yes | 0.2 s |
| Persistent State Limit Fault | completed: 11<br>limit fault: persistent: 20 | 0 |  | yes | 0.1 s |
| call depth Limit Fault at the default depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at the conformance minimum depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at a depth of 1,000,000 | load refused: host error invalid value: 20 | 0 |  | yes | 0.0 s |
| mailbox full | mailbox full, then completed: 20 | 0 |  | yes | 0.0 s |
| throw | errored: first: 20 | 0 |  | yes | 0.0 s |
| run-time error | errored: division by zero: 20 | 0 |  | yes | 0.0 s |
| Operation failure | errored: refused: 20 | 0 |  | yes | 0.0 s |
| Host error from an Operation | errored: host error: 20 | 0 |  | yes | 0.0 s |
| hostile Script source: pathological | load refused: load error: 34<br>loaded: 3<br>loaded and ran: 7 | 0 |  | yes | 18.0 s |
| hostile Script source: mutated corpus | load refused: load error: 1933<br>loaded: 8<br>loaded and ran: 59 | 0 |  | yes | 0.4 s |
| malformed frames | host error: 10<br>ok: 4<br>protocol error: 23 | 0 |  | yes | 0.4 s |


## Script faults: wasmex

| Case | Outcomes | Lost | Lost on | Healthy after | Time |
| --- | --- | --- | --- | --- | --- |
| Fuel Limit Fault | limit fault: fuel: 20 | 0 |  | yes | 0.3 s |
| Allocation Limit Fault: a growing List | limit fault: alloc: 20 | 0 |  | yes | 7.0 s |
| Allocation Limit Fault: doubling text | limit fault: alloc: 20 | 0 |  | yes | 0.5 s |
| Persistent State Limit Fault | completed: 11<br>limit fault: persistent: 20 | 0 |  | yes | 0.7 s |
| call depth Limit Fault at the default depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at the conformance minimum depth | limit fault: depth: 20 | 0 |  | yes | 0.1 s |
| deep recursion at a depth of 1,000,000 | load refused: host error invalid value: 20 | 0 |  | yes | 0.0 s |
| mailbox full | mailbox full, then completed: 20 | 0 |  | yes | 0.0 s |
| throw | errored: first: 20 | 0 |  | yes | 0.0 s |
| run-time error | errored: division by zero: 20 | 0 |  | yes | 0.0 s |
| Operation failure | errored: refused: 20 | 0 |  | yes | 0.0 s |
| Host error from an Operation | errored: host error: 20 | 0 |  | yes | 0.0 s |
| hostile Script source: pathological | load refused: load error: 34<br>loaded: 3<br>loaded and ran: 7 | 0 |  | yes | 19.8 s |
| hostile Script source: mutated corpus | load refused: load error: 1933<br>loaded: 8<br>loaded and ran: 59 | 0 |  | yes | 0.5 s |
| malformed frames | host error: 10<br>ok: 4<br>protocol error: 21<br>refused by the transport: null_buffer: 2 | 0 |  | yes | 0.4 s |
| talk_send past the talk_buffer allocation | protocol error: 1 | 0 |  | yes | 0.0 s |

