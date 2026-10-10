# Message Layer from an Elixir Host

Measured for [#553](https://github.com/odogono/odgn-talk/issues/553), part of [#532](https://github.com/odogono/odgn-talk/issues/532), against [its thresholds](https://github.com/odogono/odgn-talk/issues/532#issuecomment-6095554407), by [`bench/message-layer/elixir`](../message-layer/elixir/). [#554](https://github.com/odogono/odgn-talk/issues/554) decides what they mean for a third Core.

| | |
| --- | --- |
| Commit | `4de40dcf` |
| Machine | Apple M5, macOS 27.0.1, load average 1.95 4.09 4.27 at the start |
| Elixir | 1.20.4, OTP 29 |
| Wasmex | 0.15.1 (wasmtime 47.0.2), Cranelift `opt_level: :speed` |
| Go | go1.27.2 |
| Docker | 29.8.0 Docker Desktop cgroup v2 |
| Reactor | `803151709641c3d9783a74972440b0e3dcaee362b55119b1edf8a3ba4c056080` |
| Samples | 5000 per latency run after 500 warm-up, 3 runs judged on the median run; 5000 instantiations; 20 instances for memory; 20 repetitions per fault; 2000 mutated sources |

## Verdict

**wasmex: misses 4 rows**

| Row | Measured | Threshold | | Note |
| --- | --- | --- | --- | --- |
| Capability call p50 | 121.5 µs | ≤ 500.0 µs | pass | p99 564.5 µs |
| Pump p50 | 185.8 µs | ≤ 250.0 µs | pass | p99 543.8 µs |
| Instantiation p50 | 1.2 ms | ≤ 50.0 ms | pass | p99 2.37 ms |
| Memory per instance (median) | 28.5 MiB | ≤ 16.0 MiB | **miss** |  |
| Payload, Brotli | 2.0 MiB | ≤ 3.0 MiB | pass |  |
| Payload, raw | 11.7 MiB | ≤ 25.0 MiB | pass |  |
| Memory containment, default limits under 128.0 MiB | a growing List: lost (runtime: out of memory: cannot allocate 38797312-byte block (115081216 in use)) | Limit Fault, never out of memory | **miss** |  |
| Memory containment, conformance minimum limits under 1024.0 MiB | a growing List: lost (runtime: out of memory: cannot allocate 291504128-byte block (816611328 in use)); a growing Script Variable: lost (runtime: out of memory: cannot allocate 437256192-byte block (895221760 in use)) | Limit Fault, never out of memory | **miss** |  |
| Script faults | 11 instances lost: hostile Script source: pathological (9); malformed frames (2) | no trap and no lost instance | **miss** |  |

**sidecar: misses 3 rows**

| Row | Measured | Threshold | | Note |
| --- | --- | --- | --- | --- |
| Capability call p50 | 29.9 µs | ≤ 100.0 µs | pass | p99 111.8 µs |
| Pump p50 | 45.1 µs | ≤ 100.0 µs | pass | p99 71.5 µs |
| Instantiation p50 | 4.43 ms | ≤ 100.0 ms | pass | p99 5.48 ms |
| Memory per instance (median) | 28.7 MiB | ≤ 32.0 MiB | pass |  |
| Memory containment, default limits under 128.0 MiB | a growing List: lost (container exited 137, killed by the OOM killer) | Limit Fault, never out of memory | **miss** |  |
| Memory containment, conformance minimum limits under 1024.0 MiB | a growing List: lost (container exited 137, killed by the OOM killer); a growing Script Variable: lost (container exited 137, killed by the OOM killer) | Limit Fault, never out of memory | **miss** |  |
| Script faults | 6 instances lost: hostile Script source: pathological (5); malformed frames (1) | no trap and no lost instance | **miss** |  |


## Latency

A Capability call is the time from the Host receiving one `op` need to receiving the next, inside one Pump of 100 calls. The handler answers at once with its argument, `{items: [i, "hello", true], count: 1}`. A Pump is a `deliver` and a `pump` of an empty Handler. Instantiation runs from a compiled module (Wasmex) or process spawn (sidecar) to the `hello` reply.

| Transport | Figure | p50 | p99 | mean | min | max | n | p50 of each run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sidecar | Capability call | 29.9 µs | 111.8 µs | 32.4 µs | 24.5 µs | 211.2 µs | 5049 | 30.0 µs, 29.8 µs, 29.9 µs |
| sidecar | Pump | 45.1 µs | 71.5 µs | 46.5 µs | 33.8 µs | 360.4 µs | 5000 | 44.2 µs, 45.1 µs, 45.5 µs |
| sidecar | Instantiation | 4.43 ms | 5.48 ms | 4.47 ms | 4.04 ms | 13.34 ms | 5000 | 4.43 ms, 4.42 ms, 4.44 ms |
| wasmex | Capability call | 121.5 µs | 564.5 µs | 141.3 µs | 103.3 µs | 981.2 µs | 5049 | 122.1 µs, 121.5 µs, 120.9 µs |
| wasmex | Pump | 185.8 µs | 543.8 µs | 196.8 µs | 158.1 µs | 1.05 ms | 5000 | 185.8 µs, 185.5 µs, 185.9 µs |
| wasmex | Instantiation | 1.2 ms | 2.37 ms | 1.25 ms | 1.1 ms | 7.28 ms | 5000 | 1.2 ms, 1.2 ms, 1.3 ms |
| wasmex, opt-level none | Capability call | 144.0 µs | 738.0 µs | 192.6 µs | 112.5 µs | 1.34 ms | 5049 | 144.1 µs, 143.8 µs, 144.0 µs |
| wasmex, opt-level none | Pump | 227.6 µs | 765.6 µs | 294.4 µs | 180.2 µs | 1.39 ms | 5000 | 227.6 µs, 227.6 µs, 200.0 µs |
| wasmex, opt-level none | Instantiation | 1.34 ms | 3.69 ms | 1.44 ms | 1.26 ms | 8.28 ms | 5000 | 1.34 ms, 1.35 ms, 1.34 ms |

Compiling the module, once per Engine: 837.9 ms at `none`, 919.5 ms at `speed`.

### Memory per instance

Linear memory for Wasmex, RSS for the sidecar, after `hello`, a `new-group`, loading a small Script and one Pump.

| Transport | median | max | instances |
| --- | --- | --- | --- |
| sidecar | 28.7 MiB | 29.3 MiB | 20 |
| wasmex | 28.5 MiB | 29.0 MiB | 20 |
| wasmex, opt-level none | 29.0 MiB | 31.0 MiB | 20 |

## Memory containment

Each Script runs on a fresh instance. Without a cap, the memory observed is what the Script reached before its Limit Faults. Linear memory never shrinks, so for Wasmex it is the peak.

| Transport | Limits | Cap | Script | Outcomes | Observed |
| --- | --- | --- | --- | --- | --- |
| sidecar | default limits | none | a growing List | limit fault: alloc: 20 | cgroup peak 387.7 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | none | doubling text | limit fault: alloc: 20 | cgroup peak 71.4 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | none | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | cgroup peak 78.2 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | 128.0 MiB | a growing List | lost: 1 | container exited 137, killed by the OOM killer |
| sidecar | default limits | 128.0 MiB | doubling text | limit fault: alloc: 20 | cgroup peak 60.1 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | default limits | 128.0 MiB | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | cgroup peak 77.4 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | none | a growing List | limit fault: alloc: 20 | cgroup peak 4661.5 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | none | doubling text | limit fault: alloc: 20 | cgroup peak 491.3 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | none | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | cgroup peak 1804.3 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | 1024.0 MiB | a growing List | lost: 1 | container exited 137, killed by the OOM killer |
| sidecar | conformance minimum limits | 1024.0 MiB | doubling text | limit fault: alloc: 20 | cgroup peak 489.5 MiB; low 0, high 0, max 0, oom 0, oom_kill 0, oom_group_kill 0, sock_throttled 0 |
| sidecar | conformance minimum limits | 1024.0 MiB | a growing Script Variable | completed: 76<br>lost: 1 | container exited 137, killed by the OOM killer |
| wasmex | default limits | none | a growing List | limit fault: alloc: 20 | linear memory 668.7 MiB |
| wasmex | default limits | none | doubling text | limit fault: alloc: 20 | linear memory 56.5 MiB |
| wasmex | default limits | none | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | linear memory 76.0 MiB |
| wasmex | default limits | 128.0 MiB | a growing List | lost: 1 | linear memory 118.0 MiB |
| wasmex | default limits | 128.0 MiB | doubling text | limit fault: alloc: 20 | linear memory 45.0 MiB |
| wasmex | default limits | 128.0 MiB | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | linear memory 75.5 MiB |
| wasmex | conformance minimum limits | none | a growing List | lost: 1 | linear memory 4083.0 MiB |
| wasmex | conformance minimum limits | none | doubling text | limit fault: alloc: 20 | linear memory 478.0 MiB |
| wasmex | conformance minimum limits | none | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | linear memory 3296.8 MiB |
| wasmex | conformance minimum limits | 1024.0 MiB | a growing List | lost: 1 | linear memory 795.0 MiB |
| wasmex | conformance minimum limits | 1024.0 MiB | doubling text | limit fault: alloc: 20 | linear memory 476.0 MiB |
| wasmex | conformance minimum limits | 1024.0 MiB | a growing Script Variable | completed: 69<br>lost: 1 | linear memory 871.4 MiB |

## Script faults: sidecar

| Case | Outcomes | Lost | Lost on | Healthy after | Time |
| --- | --- | --- | --- | --- | --- |
| Fuel Limit Fault | limit fault: fuel: 20 | 0 |  | yes | 0.3 s |
| Allocation Limit Fault: a growing List | limit fault: alloc: 20 | 0 |  | yes | 6.7 s |
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
| hostile Script source: pathological | load refused: load error: 27<br>loaded: 3<br>loaded and ran: 9<br>lost: 5 | 5 | 200024 bytes: "on go\n  return (((((((((((((((((((((((((": runtime: goroutine stack exceeds 1000000000-byte limit<br>200023 bytes: "on go\n  return [[[[[[[[[[[[[[[[[[[[[[[[[": runtime: goroutine stack exceeds 1000000000-byte limit<br>500024 bytes: "on go\n  return {a: {a: {a: {a: {a: {a: {": runtime: goroutine stack exceeds 1000000000-byte limit<br>400024 bytes: "on go\n  return 1 + 1 + 1 + 1 + 1 + 1 + 1": :timeout<br>300024 bytes: "on go\n  return f(f(f(f(f(f(f(f(f(f(f(f(f": runtime: goroutine stack exceeds 1000000000-byte limit | yes | 73.7 s |
| hostile Script source: mutated corpus | load refused: load error: 1943<br>loaded: 10<br>loaded and ran: 47 | 0 |  | yes | 0.2 s |
| malformed frames | host error: 10<br>lost: 1<br>ok: 4<br>protocol error: 22 | 1 | a frame over the 64 MiB frame limit: messagelayer: frame of 67108898 bytes is over 67108864 | yes | 1.0 s |


## Script faults: wasmex

| Case | Outcomes | Lost | Lost on | Healthy after | Time |
| --- | --- | --- | --- | --- | --- |
| Fuel Limit Fault | limit fault: fuel: 20 | 0 |  | yes | 1.3 s |
| Allocation Limit Fault: a growing List | limit fault: alloc: 20 | 0 |  | yes | 56.3 s |
| Allocation Limit Fault: doubling text | limit fault: alloc: 20 | 0 |  | yes | 0.6 s |
| Persistent State Limit Fault | completed: 11<br>limit fault: persistent: 20 | 0 |  | yes | 1.2 s |
| call depth Limit Fault at the default depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at the conformance minimum depth | limit fault: depth: 20 | 0 |  | yes | 0.2 s |
| deep recursion at a depth of 1,000,000 | load refused: host error invalid value: 20 | 0 |  | yes | 0.0 s |
| mailbox full | mailbox full, then completed: 20 | 0 |  | yes | 0.0 s |
| throw | errored: first: 20 | 0 |  | yes | 0.0 s |
| run-time error | errored: division by zero: 20 | 0 |  | yes | 0.0 s |
| Operation failure | errored: refused: 20 | 0 |  | yes | 0.0 s |
| Host error from an Operation | errored: host error: 20 | 0 |  | yes | 0.0 s |
| hostile Script source: pathological | load refused: load error: 27<br>loaded: 2<br>loaded and ran: 6<br>lost: 9 | 9 | 200024 bytes: "on go\n  return (((((((((((((((((((((((((": Error during function excecution (wasm trap: call stack exhausted)<br>200023 bytes: "on go\n  return [[[[[[[[[[[[[[[[[[[[[[[[[": Error during function excecution (wasm trap: call stack exhausted)<br>500024 bytes: "on go\n  return {a: {a: {a: {a: {a: {a: {": Error during function excecution (wasm trap: call stack exhausted)<br>400024 bytes: "on go\n  return 1 + 1 + 1 + 1 + 1 + 1 + 1": Error during function excecution (wasm trap: call stack exhausted)<br>300024 bytes: "on go\n  return f(f(f(f(f(f(f(f(f(f(f(f(f": Error during function excecution (wasm trap: call stack exhausted)<br>200013 bytes: "on go\nif true then\nif true then\nif true ": Error during function excecution (wasm trap: call stack exhausted)<br>260013 bytes: "on go\nrepeat forever\nrepeat forever\nrepe": Error during function excecution (wasm trap: call stack exhausted)<br>2077790 bytes: "on h1\nend h1\non h2\nend h2\non h3\nend h3\no": fatal error: out of memory<br>1000000 bytes: "\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n": fatal error: out of memory | yes | 17.2 s |
| hostile Script source: mutated corpus | load refused: load error: 1943<br>loaded: 10<br>loaded and ran: 47 | 0 |  | yes | 0.7 s |
| malformed frames | host error: 10<br>lost: 2<br>ok: 4<br>protocol error: 19<br>refused by the transport: null_buffer: 2 | 2 | deep JSON arrays: Error during function excecution (wasm trap: call stack exhausted)<br>deep JSON objects: Error during function excecution (wasm trap: call stack exhausted) | yes | 3.7 s |
| talk_send past the talk_buffer allocation | protocol error: 1 | 0 |  | yes | 0.0 s |

