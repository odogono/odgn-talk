---
type: perf
---
Speed up the Go Core's instruction loop: each instruction now runs on its live frame and undoes only what it changed when it raises or can't pay, instead of copying the frame's stack, locals and receiver names first. `core/fib` runs about 9% faster and `core/loop` 7%, with the same Fuel and logical allocation (#596).
