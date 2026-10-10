---
type: perf
---
Charge each instruction's Cost Model rate without looking anything up, in both Cores. The generators compile every formula into measure and subject codes, and lowering stores each instruction's rate index, so a charge no longer parses formula text, finds its rate by key or dispatches on measure names. `core/fib` runs about 12% faster in both Cores.
