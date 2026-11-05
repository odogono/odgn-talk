---
type: perf
scope: repo
---
The Zig Core calls a Lambda of the running unit on its fast path and reuses popped frames' buffers for the next calls, so `core/lambdas` runs 40% faster and `core/calls` and `core/fib` about 15% faster, with the same Fuel (#2023).
