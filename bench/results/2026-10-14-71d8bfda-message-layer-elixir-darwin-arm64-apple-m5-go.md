# Message Layer from an Elixir Host

Measured for [#553](https://github.com/odogono/odgn-talk/issues/553), part of [#532](https://github.com/odogono/odgn-talk/issues/532), against [its thresholds](https://github.com/odogono/odgn-talk/issues/532#issuecomment-6095554407), by [`bench/message-layer/elixir`](../message-layer/elixir/). [#554](https://github.com/odogono/odgn-talk/issues/554) decides what they mean for a third Core.

| | |
| --- | --- |
| Commit | `71d8bfda` |
| Machine | Apple M5, macOS 27.0.1, load average 2.86 2.82 2.37 at the start |
| Elixir | 1.20.4, OTP 29 |
| Wasmex | 0.15.1 (wasmtime 47.0.2), Cranelift `opt_level: :speed` |
| Go | go1.27.2 |
| Docker | 29.8.0 Docker Desktop cgroup v2 |
| Reactor | `f4e19f1c9b3a07ed10104658d8a12a3475fe879761105be989a30ced8fdf773a` |
| Samples | 5000 per latency run after 500 warm-up, 3 runs judged on the median run; 5000 instantiations; 20 instances for memory; 20 repetitions per fault; 2000 mutated sources |

## Verdict

**wasmex: meets every row**

| Row | Measured | Threshold | | Note |
| --- | --- | --- | --- | --- |
| Capability call p50 | 113.7 µs | ≤ 500.0 µs | pass | p99 256.7 µs |
| Pump p50 | 210.6 µs | ≤ 250.0 µs | pass | p99 401.3 µs |
| Instantiation p50 | 1.19 ms | ≤ 50.0 ms | pass | p99 1.95 ms |
| Memory per instance (median) | 7.5 MiB | ≤ 16.0 MiB | pass |  |
| Payload, Brotli | 2.1 MiB | ≤ 3.0 MiB | pass |  |
| Payload, raw | 12.6 MiB | ≤ 25.0 MiB | pass |  |
| Memory containment, default limits under 128.0 MiB | every Run ended in a Limit Fault | Limit Fault, never out of memory | pass |  |
| Memory containment, conformance minimum limits under 1024.0 MiB | every Run ended in a Limit Fault | Limit Fault, never out of memory | pass |  |
| Script faults | no instance lost | no trap and no lost instance | pass |  |

**sidecar: meets every row**

| Row | Measured | Threshold | | Note |
| --- | --- | --- | --- | --- |
| Capability call p50 | 56.8 µs | ≤ 100.0 µs | pass | p99 161.0 µs |
| Pump p50 | 95.6 µs | ≤ 100.0 µs | pass | p99 318.8 µs |
| Instantiation p50 | 5.02 ms | ≤ 100.0 ms | pass | p99 6.5 ms |
| Memory per instance (median) | 9.0 MiB | ≤ 32.0 MiB | pass |  |
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
| sidecar | Capability call | 56.8 µs | 161.0 µs | 59.4 µs | 30.8 µs | 652.6 µs | 5049 | 57.1 µs, 53.4 µs, 56.8 µs |
| sidecar | Pump | 95.6 µs | 318.8 µs | 104.3 µs | 35.3 µs | 1.46 ms | 5000 | 97.5 µs, 95.5 µs, 95.6 µs |
| sidecar | Instantiation | 5.02 ms | 6.5 ms | 5.08 ms | 4.15 ms | 31.66 ms | 5000 | 8.84 ms, 5.02 ms, 4.53 ms |
| wasmex | Capability call | 113.7 µs | 256.7 µs | 120.0 µs | 99.2 µs | 528.9 µs | 5049 | 113.9 µs, 113.7 µs, 113.3 µs |
| wasmex | Pump | 210.6 µs | 401.3 µs | 217.3 µs | 188.2 µs | 696.1 µs | 5000 | 210.6 µs, 210.7 µs, 210.6 µs |
| wasmex | Instantiation | 1.19 ms | 1.95 ms | 1.22 ms | 1.11 ms | 2.68 ms | 5000 | 1.19 ms, 1.19 ms, 1.23 ms |
| wasmex, opt-level none | Capability call | 123.1 µs | 377.5 µs | 155.9 µs | 107.0 µs | 756.0 µs | 5049 | 123.3 µs, 123.0 µs, 123.1 µs |
| wasmex, opt-level none | Pump | 230.2 µs | 643.6 µs | 294.6 µs | 188.0 µs | 1.11 ms | 5000 | 230.2 µs, 231.8 µs, 228.3 µs |
| wasmex, opt-level none | Instantiation | 1.34 ms | 2.3 ms | 1.38 ms | 1.25 ms | 3.01 ms | 5000 | 1.34 ms, 1.33 ms, 1.34 ms |

Compiling the module, once per Engine: 881.9 ms at `none`, 975.3 ms at `speed`.

### Memory per instance

Linear memory for Wasmex, RSS for the sidecar, after `hello`, a `new-group`, loading a small Script and one Pump.

| Transport | median | max | instances |
| --- | --- | --- | --- |
| sidecar | 9.0 MiB | 9.0 MiB | 20 |
| wasmex | 7.5 MiB | 7.5 MiB | 20 |
| wasmex, opt-level none | 7.5 MiB | 7.5 MiB | 20 |

## Memory containment

Each Script runs on a fresh instance. Without a cap, the memory observed is what the Script reached before its Limit Faults. Linear memory never shrinks, so for Wasmex it is the peak.

| Transport | Limits | Cap | Script | Outcomes | Observed |
| --- | --- | --- | --- | --- | --- |
| c, wasmtime | default limits | none | a growing List | limit fault: alloc: 20 | linear memory 24.5 MiB |
| c, wasmtime | default limits | none | doubling text | limit fault: alloc: 20 | linear memory 46.5 MiB |
| c, wasmtime | default limits | none | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | linear memory 17.5 MiB |
| c, wasmtime | default limits | 128.0 MiB | a growing List | limit fault: alloc: 20 | linear memory 22.5 MiB |
| c, wasmtime | default limits | 128.0 MiB | doubling text | limit fault: alloc: 20 | linear memory 46.5 MiB |
| c, wasmtime | default limits | 128.0 MiB | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | linear memory 17.5 MiB |
| c, wasmtime | conformance minimum limits | none | a growing List | limit fault: alloc: 20 | linear memory 251.5 MiB |
| c, wasmtime | conformance minimum limits | none | doubling text | limit fault: alloc: 20 | linear memory 617.3 MiB |
| c, wasmtime | conformance minimum limits | none | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | linear memory 1561.8 MiB |
| c, wasmtime | conformance minimum limits | 1024.0 MiB | a growing List | limit fault: alloc: 20 | linear memory 222.0 MiB |
| c, wasmtime | conformance minimum limits | 1024.0 MiB | doubling text | limit fault: alloc: 20 | linear memory 617.3 MiB |
| c, wasmtime | conformance minimum limits | 1024.0 MiB | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | linear memory 887.8 MiB |
| sidecar | default limits | none | a growing List | limit fault: alloc: 20 | cgroup peak 44.8 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | none | doubling text | limit fault: alloc: 20 | cgroup peak 53.3 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | none | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | cgroup peak 32.3 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | 128.0 MiB | a growing List | limit fault: alloc: 20 | cgroup peak 40.3 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | 128.0 MiB | doubling text | limit fault: alloc: 20 | cgroup peak 53.3 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | 128.0 MiB | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | cgroup peak 33.2 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | none | a growing List | limit fault: alloc: 20 | cgroup peak 263.4 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | none | doubling text | limit fault: alloc: 20 | cgroup peak 502.3 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | none | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | cgroup peak 533.3 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | 1024.0 MiB | a growing List | limit fault: alloc: 20 | cgroup peak 260.7 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | 1024.0 MiB | doubling text | limit fault: alloc: 20 | cgroup peak 502.4 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | 1024.0 MiB | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | cgroup peak 543.1 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| wasmex | default limits | none | a growing List | limit fault: alloc: 20 | linear memory 22.5 MiB |
| wasmex | default limits | none | doubling text | limit fault: alloc: 20 | linear memory 46.5 MiB |
| wasmex | default limits | none | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | linear memory 17.5 MiB |
| wasmex | default limits | 128.0 MiB | a growing List | limit fault: alloc: 20 | linear memory 22.5 MiB |
| wasmex | default limits | 128.0 MiB | doubling text | limit fault: alloc: 20 | linear memory 46.5 MiB |
| wasmex | default limits | 128.0 MiB | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | linear memory 17.5 MiB |
| wasmex | conformance minimum limits | none | a growing List | limit fault: alloc: 20 | linear memory 242.5 MiB |
| wasmex | conformance minimum limits | none | doubling text | limit fault: alloc: 20 | linear memory 617.3 MiB |
| wasmex | conformance minimum limits | none | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | linear memory 887.8 MiB |
| wasmex | conformance minimum limits | 1024.0 MiB | a growing List | limit fault: alloc: 20 | linear memory 222.0 MiB |
| wasmex | conformance minimum limits | 1024.0 MiB | doubling text | limit fault: alloc: 20 | linear memory 617.3 MiB |
| wasmex | conformance minimum limits | 1024.0 MiB | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | linear memory 884.4 MiB |

## Script faults: c, wasmtime

| Case | Outcomes | Lost | Lost on | Healthy after | Time |
| --- | --- | --- | --- | --- | --- |
| Fuel Limit Fault | limit fault: fuel: 20 | 0 |  | yes | 0.3 s |
| Allocation Limit Fault: a growing List | limit fault: alloc: 20 | 0 |  | yes | 7.5 s |
| Allocation Limit Fault: doubling text | limit fault: alloc: 20 | 0 |  | yes | 0.5 s |
| Persistent State Limit Fault | completed: 11<br>limit fault: persistent: 20 | 0 |  | yes | 0.8 s |
| call depth Limit Fault at the default depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at the conformance minimum depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at a depth of 1,000,000 | load refused: host error invalid value: 20 | 0 |  | yes | 0.0 s |
| mailbox full | mailbox full, then completed: 20 | 0 |  | yes | 0.0 s |
| throw | errored: first: 20 | 0 |  | yes | 0.0 s |
| run-time error | errored: division by zero: 20 | 0 |  | yes | 0.0 s |
| Operation failure | errored: refused: 20 | 0 |  | yes | 0.0 s |
| Host error from an Operation | errored: host error: 20 | 0 |  | yes | 0.0 s |
| hostile Script source: pathological | load refused: load error: 34<br>loaded: 3<br>loaded and ran: 7 | 0 |  | yes | 21.6 s |
| hostile Script source: mutated corpus | load refused: load error: 1934<br>loaded: 3<br>loaded and ran: 63 | 0 |  | yes | 0.5 s |
| malformed frames | host error: 10<br>ok: 6<br>protocol error: 19<br>refused by the transport: null_buffer: 2 | 0 |  | yes | 0.9 s |


## Script faults: sidecar

| Case | Outcomes | Lost | Lost on | Healthy after | Time |
| --- | --- | --- | --- | --- | --- |
| Fuel Limit Fault | limit fault: fuel: 20 | 0 |  | yes | 0.2 s |
| Allocation Limit Fault: a growing List | limit fault: alloc: 20 | 0 |  | yes | 2.5 s |
| Allocation Limit Fault: doubling text | limit fault: alloc: 20 | 0 |  | yes | 0.3 s |
| Persistent State Limit Fault | completed: 11<br>limit fault: persistent: 20 | 0 |  | yes | 0.3 s |
| call depth Limit Fault at the default depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at the conformance minimum depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at a depth of 1,000,000 | load refused: host error invalid value: 20 | 0 |  | yes | 0.0 s |
| mailbox full | mailbox full, then completed: 20 | 0 |  | yes | 0.0 s |
| throw | errored: first: 20 | 0 |  | yes | 0.0 s |
| run-time error | errored: division by zero: 20 | 0 |  | yes | 0.0 s |
| Operation failure | errored: refused: 20 | 0 |  | yes | 0.0 s |
| Host error from an Operation | errored: host error: 20 | 0 |  | yes | 0.0 s |
| hostile Script source: pathological | load refused: load error: 34<br>loaded: 3<br>loaded and ran: 7 | 0 |  | yes | 31.3 s |
| hostile Script source: mutated corpus | load refused: load error: 1934<br>loaded: 3<br>loaded and ran: 63 | 0 |  | yes | 0.5 s |
| malformed frames | host error: 10<br>ok: 6<br>protocol error: 21 | 0 |  | yes | 0.5 s |


## Script faults: wasmex

| Case | Outcomes | Lost | Lost on | Healthy after | Time |
| --- | --- | --- | --- | --- | --- |
| Fuel Limit Fault | limit fault: fuel: 20 | 0 |  | yes | 0.3 s |
| Allocation Limit Fault: a growing List | limit fault: alloc: 20 | 0 |  | yes | 7.5 s |
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
| hostile Script source: pathological | load refused: load error: 34<br>loaded: 3<br>loaded and ran: 7 | 0 |  | yes | 22.8 s |
| hostile Script source: mutated corpus | load refused: load error: 1934<br>loaded: 3<br>loaded and ran: 63 | 0 |  | yes | 1.1 s |
| malformed frames | host error: 10<br>ok: 6<br>protocol error: 19<br>refused by the transport: null_buffer: 2 | 0 |  | yes | 1.2 s |
| talk_send past the talk_buffer allocation | protocol error: 1 | 0 |  | yes | 0.0 s |

