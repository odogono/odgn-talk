// The WASM build: a reactor that exports the core workloads to the Host.
package main

import "spike/core"

func main() {}

//go:wasmexport bench
func bench(kind, n int32) int64 { return core.Bench(kind, n) }

//go:wasmexport star_bench
func starBench(kind, n int32) int64 { return core.StarBench(kind, n) }

//go:wasmexport try_panic
func tryPanic(kind, rec int32) int32 { return core.TryPanic(kind, rec) }

//go:wasmexport recurse
func recurse(n int32) int64 { return core.Recurse(n) }

//go:wasmexport hold
func hold(mb int32) int32 { return core.Hold(mb) }

//go:wasmexport release
func release() { core.Release() }

//go:wasmexport heap_bytes
func heapBytes() int64 { return core.HeapBytes() }
