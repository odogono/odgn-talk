// Package core is the workload both the native runner and the WASM exports
// call, so every build measures the same code.
package core

import (
	"runtime"

	"spike/vm"
)

var progs = []*vm.Program{vm.Fib, vm.Loop, vm.Strings, vm.Maps}

// Bench runs toy-VM program kind (0 fib, 1 loop, 2 strings, 3 maps) on n.
func Bench(kind, n int32) int64 {
	v, _, err := progs[kind].Run([]vm.Value{vm.I(int64(n))}, 1<<50)
	if err != nil {
		return -1
	}
	return v.N
}

// TryPanic triggers panic kind and reports 1 if a deferred recover caught
// it. With rec == 0 there is no recover, so the panic escapes to the Host.
func TryPanic(kind, rec int32) (caught int32) {
	if rec != 0 {
		defer func() {
			if recover() != nil {
				caught = 1
			}
		}()
	}
	switch kind {
	case 0:
		panic("boom")
	case 1:
		vm.DivZero.Run(nil, 100)
	case 2:
		vm.IndexOOR.Run(nil, 100)
	case 3:
		var m map[string]int
		m["x"] = 1
	case 4:
		var p *vm.Program
		sink = len(p.Funcs)
	case 5:
		sink = deep(10_000_000)
	}
	return 0
}

var sink int

// Recurse runs n levels of plain Go recursion, as a tree-walking
// interpreter would.
func Recurse(n int32) int64 { return int64(deep(int(n))) }

//go:noinline
func deep(n int) int {
	var pad [8]int
	pad[n%8] = n
	if n <= 0 {
		return 0
	}
	return deep(n-1) + pad[(n+1)%8] + 1
}

var held [][]byte

// Hold allocates and touches mb more MiB, keeping it live. Returns MiB held.
func Hold(mb int32) int32 {
	for i := int32(0); i < mb; i++ {
		b := make([]byte, 1<<20)
		for j := 0; j < len(b); j += 4096 {
			b[j] = 1
		}
		held = append(held, b)
	}
	return int32(len(held))
}

// Release drops everything Hold kept and forces a collection.
func Release() {
	held = nil
	runtime.GC()
}

// HeapBytes reports the runtime's view of heap in use.
func HeapBytes() int64 {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	return int64(ms.HeapInuse)
}
