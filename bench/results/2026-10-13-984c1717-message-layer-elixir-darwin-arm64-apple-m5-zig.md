# Message Layer from an Elixir Host

Measured for [#553](https://github.com/odogono/odgn-talk/issues/553), part of [#532](https://github.com/odogono/odgn-talk/issues/532), against [its thresholds](https://github.com/odogono/odgn-talk/issues/532#issuecomment-6095554407), by [`bench/message-layer/elixir`](../message-layer/elixir/). [#554](https://github.com/odogono/odgn-talk/issues/554) decides what they mean for a third Core.

| | |
| --- | --- |
| Commit | `984c1717` |
| Machine | Apple M5, macOS 27.0.1, load average 3.96 3.50 2.98 at the start |
| Elixir | 1.20.4, OTP 29 |
| Wasmex | 0.15.1 (wasmtime 47.0.2), Cranelift `opt_level: :speed` |
| Go | go1.27.2 |
| Docker | 29.8.0 Docker Desktop cgroup v2 |
| Reactor | `7df26cd119f144f5f9c95907e13998c77ae4f126c9014f948e69f8240ce3963a` |
| Samples | 5000 per latency run after 500 warm-up, 3 runs judged on the median run; 5000 instantiations; 20 instances for memory; 20 repetitions per fault; 2000 mutated sources |

## Verdict

**wasmex: misses 2 rows**

| Row | Measured | Threshold | | Note |
| --- | --- | --- | --- | --- |
| Capability call p50 | 47.8 µs | ≤ 500.0 µs | pass | p99 122.7 µs |
| Pump p50 | 85.9 µs | ≤ 250.0 µs | pass | p99 283.7 µs |
| Instantiation p50 | 148.3 µs | ≤ 50.0 ms | pass | p99 661.4 µs |
| Memory per instance (median) | 1.9 MiB | ≤ 16.0 MiB | pass |  |
| Payload, Brotli | 0.6 MiB | ≤ 3.0 MiB | pass |  |
| Payload, raw | 2.4 MiB | ≤ 25.0 MiB | pass |  |
| Memory containment, default limits under 128.0 MiB | every Run ended in a Limit Fault | Limit Fault, never out of memory | pass |  |
| Memory containment, conformance minimum limits under 1024.0 MiB | doubling text: deliver refused: host error out of memory | Limit Fault, never out of memory | **miss** |  |
| Script faults | 0 instances lost:  | no trap and no lost instance | **miss** | failed health check after: mailbox full |

**c, wasmtime: misses 2 rows**

| Row | Measured | Threshold | | Note |
| --- | --- | --- | --- | --- |
| Memory containment, default limits under 128.0 MiB | every Run ended in a Limit Fault | Limit Fault, never out of memory | pass |  |
| Memory containment, conformance minimum limits under 1024.0 MiB | doubling text: deliver refused: host error out of memory | Limit Fault, never out of memory | **miss** |  |
| Script faults | 0 instances lost:  | no trap and no lost instance | **miss** | failed health check after: mailbox full |


## Latency

A Capability call is the time from the Host receiving one `op` need to receiving the next, inside one Pump of 100 calls. The handler answers at once with its argument, `{items: [i, "hello", true], count: 1}`. A Pump is a `deliver` and a `pump` of an empty Handler. Instantiation runs from a compiled module (Wasmex) or process spawn (sidecar) to the `hello` reply.

| Transport | Figure | p50 | p99 | mean | min | max | n | p50 of each run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| wasmex | Capability call | 47.8 µs | 122.7 µs | 52.0 µs | 36.6 µs | 272.5 µs | 5049 | 48.3 µs, 47.8 µs, 47.8 µs |
| wasmex | Pump | 85.9 µs | 283.7 µs | 94.6 µs | 69.0 µs | 334.9 µs | 5000 | 85.8 µs, 85.9 µs, 86.6 µs |
| wasmex | Instantiation | 148.3 µs | 661.4 µs | 176.1 µs | 131.0 µs | 4.83 ms | 5000 | 148.3 µs, 148.8 µs, 148.0 µs |
| wasmex, opt-level none | Capability call | 71.3 µs | 128.0 µs | 74.2 µs | 35.9 µs | 247.8 µs | 5049 | 72.0 µs, 70.8 µs, 71.3 µs |
| wasmex, opt-level none | Pump | 146.9 µs | 219.7 µs | 151.4 µs | 105.0 µs | 286.1 µs | 5000 | 111.4 µs, 203.0 µs, 146.9 µs |
| wasmex, opt-level none | Instantiation | 252.3 µs | 713.0 µs | 280.9 µs | 220.4 µs | 5.37 ms | 5000 | 255.8 µs, 252.3 µs, 250.3 µs |

Compiling the module, once per Engine: 257.7 ms at `none`, 294.9 ms at `speed`.

### Memory per instance

Linear memory for Wasmex, RSS for the sidecar, after `hello`, a `new-group`, loading a small Script and one Pump.

| Transport | median | max | instances |
| --- | --- | --- | --- |
| wasmex | 1.9 MiB | 1.9 MiB | 20 |
| wasmex, opt-level none | 1.9 MiB | 1.9 MiB | 20 |

## Memory containment

Each Script runs on a fresh instance. Without a cap, the memory observed is what the Script reached before its Limit Faults. Linear memory never shrinks, so for Wasmex it is the peak.

| Transport | Limits | Cap | Script | Outcomes | Observed |
| --- | --- | --- | --- | --- | --- |
| c, wasmtime | default limits | none | a growing List | limit fault: alloc: 20 | linear memory 6.9 MiB |
| c, wasmtime | default limits | none | doubling text | limit fault: alloc: 20 | linear memory 76.8 MiB |
| c, wasmtime | default limits | none | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | linear memory 2.4 MiB |
| c, wasmtime | default limits | 128.0 MiB | a growing List | limit fault: alloc: 20 | linear memory 6.9 MiB |
| c, wasmtime | default limits | 128.0 MiB | doubling text | limit fault: alloc: 20 | linear memory 76.8 MiB |
| c, wasmtime | default limits | 128.0 MiB | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | linear memory 2.4 MiB |
| c, wasmtime | conformance minimum limits | none | a growing List | limit fault: alloc: 20 | linear memory 88.9 MiB |
| c, wasmtime | conformance minimum limits | none | doubling text | limit fault: alloc: 20 | linear memory 1196.8 MiB |
| c, wasmtime | conformance minimum limits | none | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | linear memory 32.9 MiB |
| c, wasmtime | conformance minimum limits | 1024.0 MiB | a growing List | limit fault: alloc: 20 | linear memory 88.9 MiB |
| c, wasmtime | conformance minimum limits | 1024.0 MiB | doubling text | deliver refused: host error out of memory: 20 | linear memory 940.8 MiB |
| c, wasmtime | conformance minimum limits | 1024.0 MiB | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | linear memory 32.9 MiB |
| wasmex | default limits | none | a growing List | limit fault: alloc: 20 | linear memory 6.9 MiB |
| wasmex | default limits | none | doubling text | limit fault: alloc: 20 | linear memory 76.8 MiB |
| wasmex | default limits | none | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | linear memory 2.4 MiB |
| wasmex | default limits | 128.0 MiB | a growing List | limit fault: alloc: 20 | linear memory 6.9 MiB |
| wasmex | default limits | 128.0 MiB | doubling text | limit fault: alloc: 20 | linear memory 76.8 MiB |
| wasmex | default limits | 128.0 MiB | a growing Script Variable | completed: 11<br>limit fault: persistent: 20 | linear memory 2.4 MiB |
| wasmex | conformance minimum limits | none | a growing List | limit fault: alloc: 20 | linear memory 88.9 MiB |
| wasmex | conformance minimum limits | none | doubling text | limit fault: alloc: 20 | linear memory 1196.8 MiB |
| wasmex | conformance minimum limits | none | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | linear memory 32.9 MiB |
| wasmex | conformance minimum limits | 1024.0 MiB | a growing List | limit fault: alloc: 20 | linear memory 88.9 MiB |
| wasmex | conformance minimum limits | 1024.0 MiB | doubling text | deliver refused: host error out of memory: 20 | linear memory 940.8 MiB |
| wasmex | conformance minimum limits | 1024.0 MiB | a growing Script Variable | completed: 76<br>limit fault: persistent: 20 | linear memory 32.9 MiB |

## Script faults: c, wasmtime

| Case | Outcomes | Lost | Lost on | Healthy after | Time |
| --- | --- | --- | --- | --- | --- |
| Fuel Limit Fault | limit fault: fuel: 20 | 0 |  | yes | 0.1 s |
| Allocation Limit Fault: a growing List | limit fault: alloc: 20 | 0 |  | yes | 1.9 s |
| Allocation Limit Fault: doubling text | limit fault: alloc: 20 | 0 |  | yes | 0.5 s |
| Persistent State Limit Fault | completed: 11<br>limit fault: persistent: 20 | 0 |  | yes | 0.0 s |
| call depth Limit Fault at the default depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at the conformance minimum depth | limit fault: depth: 20 | 0 |  | yes | 0.1 s |
| deep recursion at a depth of 1,000,000 | deliver refused: host error out of memory: 3<br>load refused: host error out of memory: 17 | 0 |  | yes | 0.7 s |
| mailbox full | harness error: ** (MatchError) no match of right hand side value:

    {%TalkHost.Session{
       transport: %TalkHost.Transport.Bridge{
         sidecar: %TalkHost.Transport.Sidecar{
           port: #Port<0.35>,
           os_pid: 12063,
           timeout: 60000,
           stderr: "/var/folders/cw/yqrxs3451dz_9nwkg5sv4v0r0000gn/T/talk-sidecar-74850.stderr"
         },
         memory: "/var/folders/cw/yqrxs3451dz_9nwkg5sv4v0r0000gn/T/talk-bridge-74818.memory"
       },
       ref: 570,
       ops: %{
      | 0 |  | **no** | 0.0 s |
| throw | errored: first: 20 | 0 |  | yes | 0.0 s |
| run-time error | errored: division by zero: 20 | 0 |  | yes | 0.0 s |
| Operation failure | errored: refused: 20 | 0 |  | yes | 0.0 s |
| Host error from an Operation | errored: host error: 20 | 0 |  | yes | 0.0 s |
| hostile Script source: pathological | load refused: load error: 34<br>loaded: 3<br>loaded and ran: 7 | 0 |  | yes | 13.5 s |
| hostile Script source: mutated corpus | load refused: load error: 1939<br>loaded: 6<br>loaded and ran: 55 | 0 |  | yes | 0.2 s |
| malformed frames | host error: 12<br>ok: 5<br>protocol error: 18<br>refused by the transport: null_buffer: 2 | 0 |  | yes | 0.5 s |


## Script faults: wasmex

| Case | Outcomes | Lost | Lost on | Healthy after | Time |
| --- | --- | --- | --- | --- | --- |
| Fuel Limit Fault | limit fault: fuel: 20 | 0 |  | yes | 0.1 s |
| Allocation Limit Fault: a growing List | limit fault: alloc: 20 | 0 |  | yes | 1.7 s |
| Allocation Limit Fault: doubling text | limit fault: alloc: 20 | 0 |  | yes | 0.8 s |
| Persistent State Limit Fault | completed: 11<br>limit fault: persistent: 20 | 0 |  | yes | 0.1 s |
| call depth Limit Fault at the default depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at the conformance minimum depth | limit fault: depth: 20 | 0 |  | yes | 0.0 s |
| deep recursion at a depth of 1,000,000 | deliver refused: host error out of memory: 3<br>load refused: host error out of memory: 17 | 0 |  | yes | 0.6 s |
| mailbox full | harness error: ** (MatchError) no match of right hand side value:

    {%TalkHost.Session{
       transport: %TalkHost.Transport.Wasi{
         pid: #PID<0.30359.0>,
         store: #Wasmex.StoreOrCaller<#Reference<0.275105030.1509163009.21944>>,
         memory: #Wasmex.Memory<#Reference<0.275105030.1509163009.21952>>,
         stderr: #Wasmex.Pipe<#Reference<0.275105030.1509163009.21942>>,
         timeout: 60000
       },
       ref: 570,
       ops: %{
         "break" => &TalkHost.Faults.break_op/1,
      | 0 |  | **no** | 0.0 s |
| throw | errored: first: 20 | 0 |  | yes | 0.0 s |
| run-time error | errored: division by zero: 20 | 0 |  | yes | 0.0 s |
| Operation failure | errored: refused: 20 | 0 |  | yes | 0.0 s |
| Host error from an Operation | errored: host error: 20 | 0 |  | yes | 0.0 s |
| hostile Script source: pathological | load refused: load error: 34<br>loaded: 3<br>loaded and ran: 7 | 0 |  | yes | 12.3 s |
| hostile Script source: mutated corpus | load refused: load error: 1939<br>loaded: 6<br>loaded and ran: 55 | 0 |  | yes | 0.5 s |
| malformed frames | host error: 12<br>ok: 5<br>protocol error: 18<br>refused by the transport: null_buffer: 2 | 0 |  | yes | 0.5 s |
| talk_send past the talk_buffer allocation | protocol error: 1 | 0 |  | yes | 0.0 s |

