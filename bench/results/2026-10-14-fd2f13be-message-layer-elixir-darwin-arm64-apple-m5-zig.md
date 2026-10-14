# Message Layer from an Elixir Host

Measured for [#553](https://github.com/odogono/odgn-talk/issues/553), part of [#532](https://github.com/odogono/odgn-talk/issues/532), against [its thresholds](https://github.com/odogono/odgn-talk/issues/532#issuecomment-6095554407), by [`bench/message-layer/elixir`](../message-layer/elixir/). [#554](https://github.com/odogono/odgn-talk/issues/554) decides what they mean for a third Core.

| | |
| --- | --- |
| Commit | `fd2f13be` |
| Machine | Apple M5, macOS 27.0.1, load average 4.57 3.05 2.94 at the start |
| Elixir | 1.20.4, OTP 29 |
| Wasmex | 0.15.1 (wasmtime 47.0.2), Cranelift `opt_level: :speed` |
| Go | go1.27.2 |
| Docker | 29.8.0 Docker Desktop cgroup v2 |
| Reactor | `bf98df48ee760795c8c5e5ea82fc776a00420ce7bf30c168a9065b85fde4de01` |
| Samples | 5000 per latency run after 500 warm-up, 3 runs judged on the median run; 5000 instantiations; 20 instances for memory; 20 repetitions per fault; 2000 mutated sources |

## Verdict

**wasmex: meets every row**

| Row | Measured | Threshold | | Note |
| --- | --- | --- | --- | --- |
| Capability call p50 | 57.4 µs | ≤ 500.0 µs | pass | p99 71.6 µs |
| Pump p50 | 96.8 µs | ≤ 250.0 µs | pass | p99 153.3 µs |
| Instantiation p50 | 161.2 µs | ≤ 50.0 ms | pass | p99 666.0 µs |
| Memory per instance (median) | 2.0 MiB | ≤ 16.0 MiB | pass |  |
| Payload, Brotli | 0.6 MiB | ≤ 3.0 MiB | pass |  |
| Payload, raw | 2.7 MiB | ≤ 25.0 MiB | pass |  |
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
| wasmex | Capability call | 57.4 µs | 71.6 µs | 56.8 µs | 42.4 µs | 135.1 µs | 5049 | 57.2 µs, 57.4 µs, 57.4 µs |
| wasmex | Pump | 96.8 µs | 153.3 µs | 97.2 µs | 69.8 µs | 308.0 µs | 5000 | 86.2 µs, 98.6 µs, 96.8 µs |
| wasmex | Instantiation | 161.2 µs | 666.0 µs | 183.2 µs | 134.3 µs | 1.04 ms | 5000 | 159.9 µs, 161.2 µs, 161.5 µs |
| wasmex, opt-level none | Capability call | 57.2 µs | 78.3 µs | 56.7 µs | 40.4 µs | 244.4 µs | 5049 | 57.2 µs, 58.1 µs, 56.1 µs |
| wasmex, opt-level none | Pump | 101.1 µs | 126.8 µs | 101.6 µs | 80.1 µs | 269.0 µs | 5000 | 101.3 µs, 99.0 µs, 101.1 µs |
| wasmex, opt-level none | Instantiation | 161.1 µs | 635.1 µs | 181.0 µs | 135.2 µs | 1.08 ms | 5000 | 161.1 µs, 161.1 µs, 160.5 µs |

Compiling the module, once per Engine: 242.8 ms at `none`, 308.4 ms at `speed`.

### Memory per instance

Linear memory for Wasmex, RSS for the sidecar, after `hello`, a `new-group`, loading a small Script and one Pump.

| Transport | median | max | instances |
| --- | --- | --- | --- |
| wasmex | 2.0 MiB | 2.0 MiB | 20 |
| wasmex, opt-level none | 2.0 MiB | 2.0 MiB | 20 |

## Memory containment

Each Script runs on a fresh instance. Without a cap, the memory observed is what the Script reached before its Limit Faults. Linear memory never shrinks, so for Wasmex it is the peak.

| Transport | Limits | Cap | Script | Outcomes | Observed |
| --- | --- | --- | --- | --- | --- |
| c, wasmtime | default limits | none | a growing List | limit fault: alloc: 20 | linear memory 7.0 MiB |
| c, wasmtime | default limits | none | doubling text | limit fault: alloc: 20 | linear memory 34.2 MiB |
| c, wasmtime | default limits | none | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | linear memory 2.5 MiB |
| c, wasmtime | default limits | 128.0 MiB | a growing List | limit fault: alloc: 20 | linear memory 7.0 MiB |
| c, wasmtime | default limits | 128.0 MiB | doubling text | limit fault: alloc: 20 | linear memory 34.2 MiB |
| c, wasmtime | default limits | 128.0 MiB | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | linear memory 2.5 MiB |
| c, wasmtime | conformance minimum limits | none | a growing List | limit fault: alloc: 20 | linear memory 89.0 MiB |
| c, wasmtime | conformance minimum limits | none | doubling text | limit fault: alloc: 20 | linear memory 514.2 MiB |
| c, wasmtime | conformance minimum limits | none | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | linear memory 33.0 MiB |
| c, wasmtime | conformance minimum limits | 1024.0 MiB | a growing List | limit fault: alloc: 20 | linear memory 89.0 MiB |
| c, wasmtime | conformance minimum limits | 1024.0 MiB | doubling text | limit fault: alloc: 20 | linear memory 514.2 MiB |
| c, wasmtime | conformance minimum limits | 1024.0 MiB | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | linear memory 33.0 MiB |
| wasmex | default limits | none | a growing List | limit fault: alloc: 20 | linear memory 7.0 MiB |
| wasmex | default limits | none | doubling text | limit fault: alloc: 20 | linear memory 34.2 MiB |
| wasmex | default limits | none | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | linear memory 2.5 MiB |
| wasmex | default limits | 128.0 MiB | a growing List | limit fault: alloc: 20 | linear memory 7.0 MiB |
| wasmex | default limits | 128.0 MiB | doubling text | limit fault: alloc: 20 | linear memory 34.2 MiB |
| wasmex | default limits | 128.0 MiB | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | linear memory 2.5 MiB |
| wasmex | conformance minimum limits | none | a growing List | limit fault: alloc: 20 | linear memory 89.0 MiB |
| wasmex | conformance minimum limits | none | doubling text | limit fault: alloc: 20 | linear memory 514.2 MiB |
| wasmex | conformance minimum limits | none | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | linear memory 33.0 MiB |
| wasmex | conformance minimum limits | 1024.0 MiB | a growing List | limit fault: alloc: 20 | linear memory 89.0 MiB |
| wasmex | conformance minimum limits | 1024.0 MiB | doubling text | limit fault: alloc: 20 | linear memory 514.2 MiB |
| wasmex | conformance minimum limits | 1024.0 MiB | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | linear memory 33.0 MiB |

## Script faults: c, wasmtime

| Case | Outcomes | Lost | Lost on | Healthy after | Time |
| --- | --- | --- | --- | --- | --- |
| Fuel Limit Fault | limit fault: fuel: 20 | 0 |  | yes | 0.1 s |
| Allocation Limit Fault: a growing List | limit fault: alloc: 20 | 0 |  | yes | 1.7 s |
| Allocation Limit Fault: doubling text | limit fault: alloc: 20 | 0 |  | yes | 0.3 s |
| Persistent State Limit Fault | completed: 11<br>limit fault: persistent: 20 | 0 |  | yes | 0.0 s |
| call depth Limit Fault at the default depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at the conformance minimum depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at a depth of 1,000,000 | load refused: host error invalid value: 20 | 0 |  | yes | 0.0 s |
| mailbox full | mailbox full, then completed: 20 | 0 |  | yes | 0.0 s |
| throw | errored: first: 20 | 0 |  | yes | 0.0 s |
| run-time error | errored: division by zero: 20 | 0 |  | yes | 0.0 s |
| Operation failure | errored: refused: 20 | 0 |  | yes | 0.0 s |
| Host error from an Operation | errored: host error: 20 | 0 |  | yes | 0.0 s |
| hostile Script source: pathological | load refused: load error: 34<br>loaded: 3<br>loaded and ran: 7 | 0 |  | yes | 12.5 s |
| hostile Script source: mutated corpus | load refused: load error: 1933<br>loaded: 8<br>loaded and ran: 59 | 0 |  | yes | 0.1 s |
| malformed frames | host error: 12<br>ok: 5<br>protocol error: 18<br>refused by the transport: null_buffer: 2 | 0 |  | yes | 0.4 s |


## Script faults: wasmex

| Case | Outcomes | Lost | Lost on | Healthy after | Time |
| --- | --- | --- | --- | --- | --- |
| Fuel Limit Fault | limit fault: fuel: 20 | 0 |  | yes | 0.1 s |
| Allocation Limit Fault: a growing List | limit fault: alloc: 20 | 0 |  | yes | 1.9 s |
| Allocation Limit Fault: doubling text | limit fault: alloc: 20 | 0 |  | yes | 0.7 s |
| Persistent State Limit Fault | completed: 11<br>limit fault: persistent: 20 | 0 |  | yes | 0.0 s |
| call depth Limit Fault at the default depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at the conformance minimum depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at a depth of 1,000,000 | load refused: host error invalid value: 20 | 0 |  | yes | 0.0 s |
| mailbox full | mailbox full, then completed: 20 | 0 |  | yes | 0.0 s |
| throw | errored: first: 20 | 0 |  | yes | 0.0 s |
| run-time error | errored: division by zero: 20 | 0 |  | yes | 0.0 s |
| Operation failure | errored: refused: 20 | 0 |  | yes | 0.0 s |
| Host error from an Operation | errored: host error: 20 | 0 |  | yes | 0.0 s |
| hostile Script source: pathological | load refused: load error: 34<br>loaded: 3<br>loaded and ran: 7 | 0 |  | yes | 9.6 s |
| hostile Script source: mutated corpus | load refused: load error: 1933<br>loaded: 8<br>loaded and ran: 59 | 0 |  | yes | 0.3 s |
| malformed frames | host error: 12<br>ok: 5<br>protocol error: 18<br>refused by the transport: null_buffer: 2 | 0 |  | yes | 0.3 s |
| talk_send past the talk_buffer allocation | protocol error: 1 | 0 |  | yes | 0.0 s |

