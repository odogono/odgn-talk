# Message Layer from an Elixir Host

Measured for [#553](https://github.com/odogono/odgn-talk/issues/553), part of [#532](https://github.com/odogono/odgn-talk/issues/532), against [its thresholds](https://github.com/odogono/odgn-talk/issues/532#issuecomment-6095554407), by [`bench/message-layer/elixir`](../message-layer/elixir/). [#554](https://github.com/odogono/odgn-talk/issues/554) decides what they mean for a third Core.

| | |
| --- | --- |
| Commit | `71d8bfda` |
| Machine | Apple M5, macOS 27.0.1, load average 3.80 2.73 2.58 at the start |
| Elixir | 1.20.4, OTP 29 |
| Wasmex | 0.15.1 (wasmtime 47.0.2), Cranelift `opt_level: :speed` |
| Go | go1.27.2 |
| Docker | 29.8.0 Docker Desktop cgroup v2 |
| Reactor | `f10aec0b36da7bf6321f44d64ef14c569a7fa039b099c50c9e1955cb198dc74d` |
| Samples | 5000 per latency run after 500 warm-up, 3 runs judged on the median run; 5000 instantiations; 20 instances for memory; 20 repetitions per fault; 2000 mutated sources |

## Verdict

**wasmex: meets every row**

| Row | Measured | Threshold | | Note |
| --- | --- | --- | --- | --- |
| Capability call p50 | 55.3 µs | ≤ 500.0 µs | pass | p99 85.5 µs |
| Pump p50 | 101.6 µs | ≤ 250.0 µs | pass | p99 179.4 µs |
| Instantiation p50 | 161.2 µs | ≤ 50.0 ms | pass | p99 675.8 µs |
| Memory per instance (median) | 2.1 MiB | ≤ 16.0 MiB | pass |  |
| Payload, Brotli | 0.7 MiB | ≤ 3.0 MiB | pass |  |
| Payload, raw | 2.8 MiB | ≤ 25.0 MiB | pass |  |
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
| wasmex | Capability call | 55.3 µs | 85.5 µs | 55.4 µs | 40.4 µs | 290.0 µs | 5049 | 56.0 µs, 55.1 µs, 55.3 µs |
| wasmex | Pump | 101.6 µs | 179.4 µs | 103.2 µs | 78.7 µs | 351.5 µs | 5000 | 101.6 µs, 101.6 µs, 99.1 µs |
| wasmex | Instantiation | 161.2 µs | 675.8 µs | 182.0 µs | 133.3 µs | 1.14 ms | 5000 | 161.7 µs, 160.8 µs, 161.2 µs |
| wasmex, opt-level none | Capability call | 56.4 µs | 85.5 µs | 56.3 µs | 41.4 µs | 299.5 µs | 5049 | 56.3 µs, 56.4 µs, 56.6 µs |
| wasmex, opt-level none | Pump | 101.4 µs | 178.2 µs | 102.9 µs | 78.6 µs | 345.7 µs | 5000 | 102.3 µs, 101.4 µs, 99.9 µs |
| wasmex, opt-level none | Instantiation | 161.1 µs | 673.0 µs | 181.8 µs | 134.0 µs | 1.18 ms | 5000 | 161.1 µs, 161.1 µs, 161.4 µs |

Compiling the module, once per Engine: 239.0 ms at `none`, 305.6 ms at `speed`.

### Memory per instance

Linear memory for Wasmex, RSS for the sidecar, after `hello`, a `new-group`, loading a small Script and one Pump.

| Transport | median | max | instances |
| --- | --- | --- | --- |
| wasmex | 2.1 MiB | 2.1 MiB | 20 |
| wasmex, opt-level none | 2.1 MiB | 2.1 MiB | 20 |

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
| Fuel Limit Fault | limit fault: fuel: 20 | 0 |  | yes | 0.2 s |
| Allocation Limit Fault: a growing List | limit fault: alloc: 20 | 0 |  | yes | 1.9 s |
| Allocation Limit Fault: doubling text | limit fault: alloc: 20 | 0 |  | yes | 0.4 s |
| Persistent State Limit Fault | completed: 11<br>limit fault: persistent: 20 | 0 |  | yes | 0.0 s |
| call depth Limit Fault at the default depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at the conformance minimum depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at a depth of 1,000,000 | load refused: host error invalid value: 20 | 0 |  | yes | 0.0 s |
| mailbox full | mailbox full, then completed: 20 | 0 |  | yes | 0.0 s |
| throw | errored: first: 20 | 0 |  | yes | 0.0 s |
| run-time error | errored: division by zero: 20 | 0 |  | yes | 0.0 s |
| Operation failure | errored: refused: 20 | 0 |  | yes | 0.0 s |
| Host error from an Operation | errored: host error: 20 | 0 |  | yes | 0.0 s |
| hostile Script source: pathological | load refused: load error: 34<br>loaded: 3<br>loaded and ran: 7 | 0 |  | yes | 12.9 s |
| hostile Script source: mutated corpus | load refused: load error: 1934<br>loaded: 3<br>loaded and ran: 63 | 0 |  | yes | 0.2 s |
| malformed frames | host error: 12<br>ok: 7<br>protocol error: 16<br>refused by the transport: null_buffer: 2 | 0 |  | yes | 0.4 s |


## Script faults: wasmex

| Case | Outcomes | Lost | Lost on | Healthy after | Time |
| --- | --- | --- | --- | --- | --- |
| Fuel Limit Fault | limit fault: fuel: 20 | 0 |  | yes | 0.2 s |
| Allocation Limit Fault: a growing List | limit fault: alloc: 20 | 0 |  | yes | 2.2 s |
| Allocation Limit Fault: doubling text | limit fault: alloc: 20 | 0 |  | yes | 0.9 s |
| Persistent State Limit Fault | completed: 11<br>limit fault: persistent: 20 | 0 |  | yes | 0.0 s |
| call depth Limit Fault at the default depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at the conformance minimum depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at a depth of 1,000,000 | load refused: host error invalid value: 20 | 0 |  | yes | 0.0 s |
| mailbox full | mailbox full, then completed: 20 | 0 |  | yes | 0.0 s |
| throw | errored: first: 20 | 0 |  | yes | 0.0 s |
| run-time error | errored: division by zero: 20 | 0 |  | yes | 0.0 s |
| Operation failure | errored: refused: 20 | 0 |  | yes | 0.0 s |
| Host error from an Operation | errored: host error: 20 | 0 |  | yes | 0.0 s |
| hostile Script source: pathological | load refused: load error: 34<br>loaded: 3<br>loaded and ran: 7 | 0 |  | yes | 15.7 s |
| hostile Script source: mutated corpus | load refused: load error: 1934<br>loaded: 3<br>loaded and ran: 63 | 0 |  | yes | 0.5 s |
| malformed frames | host error: 12<br>ok: 7<br>protocol error: 16<br>refused by the transport: null_buffer: 2 | 0 |  | yes | 0.5 s |
| talk_send past the talk_buffer allocation | protocol error: 1 | 0 |  | yes | 0.0 s |

