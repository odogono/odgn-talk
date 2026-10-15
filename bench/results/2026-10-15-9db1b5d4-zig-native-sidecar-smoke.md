# Message Layer from an Elixir Host

> **Quick run: these figures only check the harness.**
> Local uncommitted implementation of #965 on `fix/issue-965`, based on `9db1b5d4`; artifact hashes below identify the tested binaries.

Measured for [#553](https://github.com/odogono/odgn-talk/issues/553), part of [#532](https://github.com/odogono/odgn-talk/issues/532), against [its thresholds](https://github.com/odogono/odgn-talk/issues/532#issuecomment-6095554407), by [`bench/message-layer/elixir`](../message-layer/elixir/). [#554](https://github.com/odogono/odgn-talk/issues/554) decides what they mean for a third Core.

| | |
| --- | --- |
| Commit | `9db1b5d4` |
| Machine | Apple M5, macOS 27.0.1, load average 1.94 2.07 1.95 at the start |
| Elixir | 1.20.4, OTP 29 |
| Wasmex | 0.15.1 (wasmtime 47.0.2), Cranelift `opt_level: :speed` |
| Zig toolchain | 0.17.0 |
| Docker | 29.8.0 Docker Desktop cgroup v2 |
| Reactor | `cc1189fc7ca1c0f63830aace383ac54ad80537cfd3e06425617ab7f4da85a8c5` |
| Native sidecar | `a0eedd1fc8342b8d5366f4b3b5b106b440c74a1bff1cd59402dc1718ff650dac` |
| Samples | 500 per latency run after 100 warm-up, 1 runs judged on the median run; 30 instantiations; 3 instances for memory; 3 repetitions per fault; 100 mutated sources |

## Verdict

**sidecar: meets every row**

| Row | Measured | Threshold | | Note |
| --- | --- | --- | --- | --- |
| Capability call p50 | 12.0 µs | ≤ 100.0 µs | pass | p99 22.3 µs |
| Pump p50 | 20.5 µs | ≤ 100.0 µs | pass | p99 38.5 µs |
| Instantiation p50 | 4.06 ms | ≤ 100.0 ms | pass | p99 4.39 ms |
| Memory per instance (median) | 4.1 MiB | ≤ 32.0 MiB | pass |  |
| Memory containment, default limits under 128.0 MiB | every Run ended in a Limit Fault | Limit Fault, never out of memory | pass |  |
| Memory containment, conformance minimum limits under 1024.0 MiB | every Run ended in a Limit Fault | Limit Fault, never out of memory | pass |  |
| Script faults | no instance lost | no trap and no lost instance | pass |  |


## Latency

A Capability call is the time from the Host receiving one `op` need to receiving the next, inside one Pump of 100 calls. The handler answers at once with its argument, `{items: [i, "hello", true], count: 1}`. A Pump is a `deliver` and a `pump` of an empty Handler. Instantiation runs from a compiled module (Wasmex) or process spawn (sidecar) to the `hello` reply.

| Transport | Figure | p50 | p99 | mean | min | max | n | p50 of each run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sidecar | Capability call | 12.0 µs | 22.3 µs | 12.4 µs | 10.2 µs | 71.0 µs | 594 | 12.0 µs |
| sidecar | Pump | 20.5 µs | 38.5 µs | 21.7 µs | 18.8 µs | 55.2 µs | 500 | 20.5 µs |
| sidecar | Instantiation | 4.06 ms | 4.39 ms | 4.1 ms | 3.88 ms | 4.39 ms | 30 | 4.06 ms |

Compiling the module, once per Engine: 318.1 ms at `none`, 347.0 ms at `speed`.

### Memory per instance

Linear memory for Wasmex, RSS for the sidecar, after `hello`, a `new-group`, loading a small Script and one Pump.

| Transport | median | max | instances |
| --- | --- | --- | --- |
| sidecar | 4.1 MiB | 4.1 MiB | 3 |

## Memory containment

Each Script runs on a fresh instance. Without a cap, the memory observed is what the Script reached before its Limit Faults. Linear memory never shrinks, so for Wasmex it is the peak.

| Transport | Limits | Cap | Script | Outcomes | Observed |
| --- | --- | --- | --- | --- | --- |
| sidecar | default limits | none | a growing List | limit fault: alloc: 3 | cgroup peak 12.8 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | none | doubling text | limit fault: alloc: 3 | cgroup peak 17.4 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | none | a growing Script Variable | completed: 11<br>limit fault: persistent: 3 | cgroup peak 13.0 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | 128.0 MiB | a growing List | limit fault: alloc: 3 | cgroup peak 13.0 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | 128.0 MiB | doubling text | limit fault: alloc: 3 | cgroup peak 17.1 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | 128.0 MiB | a growing Script Variable | completed: 11<br>limit fault: persistent: 3 | cgroup peak 12.4 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | none | a growing List | limit fault: alloc: 3 | cgroup peak 65.4 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | none | doubling text | limit fault: alloc: 3 | cgroup peak 197.6 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | none | a growing Script Variable | completed: 76<br>limit fault: persistent: 3 | cgroup peak 27.9 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | 1024.0 MiB | a growing List | limit fault: alloc: 3 | cgroup peak 65.7 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | 1024.0 MiB | doubling text | limit fault: alloc: 3 | cgroup peak 197.9 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | 1024.0 MiB | a growing Script Variable | completed: 76<br>limit fault: persistent: 3 | cgroup peak 27.2 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |

## Script faults: sidecar

| Case | Outcomes | Lost | Lost on | Healthy after | Time |
| --- | --- | --- | --- | --- | --- |
| Fuel Limit Fault | limit fault: fuel: 3 | 0 |  | yes | 0.0 s |
| Allocation Limit Fault: a growing List | limit fault: alloc: 3 | 0 |  | yes | 0.1 s |
| Allocation Limit Fault: doubling text | limit fault: alloc: 3 | 0 |  | yes | 0.0 s |
| Persistent State Limit Fault | completed: 11<br>limit fault: persistent: 3 | 0 |  | yes | 0.0 s |
| call depth Limit Fault at the default depth | limit fault: depth: 3 | 0 |  | yes | 0.0 s |
| deep recursion at the conformance minimum depth | limit fault: depth: 3 | 0 |  | yes | 0.0 s |
| deep recursion at a depth of 1,000,000 | load refused: host error invalid value: 3 | 0 |  | yes | 0.0 s |
| mailbox full | mailbox full, then completed: 3 | 0 |  | yes | 0.0 s |
| throw | errored: first: 3 | 0 |  | yes | 0.0 s |
| run-time error | errored: division by zero: 3 | 0 |  | yes | 0.0 s |
| Operation failure | errored: refused: 3 | 0 |  | yes | 0.0 s |
| Host error from an Operation | errored: host error: 3 | 0 |  | yes | 0.0 s |
| hostile Script source: pathological | load refused: load error: 34<br>loaded: 3<br>loaded and ran: 7 | 0 |  | yes | 9.6 s |
| hostile Script source: mutated corpus | load refused: load error: 98<br>loaded and ran: 2 | 0 |  | yes | 0.1 s |
| malformed frames | host error: 12<br>ok: 7<br>protocol error: 18 | 0 |  | yes | 0.5 s |
