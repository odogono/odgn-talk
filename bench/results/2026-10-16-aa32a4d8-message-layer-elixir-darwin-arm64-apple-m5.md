# Message Layer from an Elixir Host

Measured for [#553](https://github.com/odogono/odgn-talk/issues/553), part of [#532](https://github.com/odogono/odgn-talk/issues/532), against [its thresholds](https://github.com/odogono/odgn-talk/issues/532#issuecomment-6095554407), by [`bench/message-layer/elixir`](../message-layer/elixir/). [#554](https://github.com/odogono/odgn-talk/issues/554) decides what they mean for a third Core.

| | |
| --- | --- |
| Commit | `aa32a4d8` |
| Machine | Apple M5, macOS 27.0.1, load average 2.38 1.89 1.65 at the start |
| Elixir | 1.20.4, OTP 29 |
| Wasmex | 0.15.1 (wasmtime 47.0.2), Cranelift `opt_level: :speed` |
| Zig toolchain | 0.17.0 |
| Docker | 29.8.0 Docker Desktop cgroup v2 |
| Reactor | `719e3398793424a60e5f78b13d5951f10a5cb52671eeed6b524f0477e0ed7f3a` |
| Samples | 5000 per latency run after 500 warm-up, 3 runs judged on the median run; 5000 instantiations; 20 instances for memory; 20 repetitions per fault; 2000 mutated sources |

## Verdict



## Through the Elixir API

The same reactor over Wasmex, driven through `NorthTalk` (impl/elixir) instead of raw frames, so these include the Instance Owner, value conversion and callback Tasks. A Request is `request/5` of an empty Handler with automatic driving, from the call to its result. A Callback is the time from one immediate callback starting to the next, inside one Request of 100 calls, each in its own Task. A Deferred Request waits on a suspending Operation whose callback returns `{:defer, ref}`, answered by `answer/3` from another process. These have no #532 threshold.

| Figure | p50 | p99 | mean | min | max | n | p50 of each run |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Request | 112.0 µs | 142.6 µs | 112.9 µs | 84.9 µs | 273.7 µs | 5000 | 111.9 µs, 112.1 µs, 112.0 µs |
| Callback | 64.3 µs | 89.5 µs | 65.0 µs | 48.9 µs | 195.7 µs | 5049 | 64.3 µs, 64.5 µs, 64.1 µs |
| Deferred Request | 320.4 µs | 394.9 µs | 322.3 µs | 273.1 µs | 938.2 µs | 5000 | 320.3 µs, 362.4 µs, 320.4 µs |

Per owner, after one Request, over 20 owners: 2.1 MiB of guest linear memory and 0.2 MiB of owner process heap, median.

