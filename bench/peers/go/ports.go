// Package peers holds the Benchmark Suite's native Go ports: idiomatic Go
// counterparts of the Benchmark Scripts, the ceiling for the Go Core.
package peers

import "github.com/odogono/odgn-talk/bench/peers/go/core"

// Ports maps each Benchmark's name to its port, which returns the value the
// Script's `run n` returns.
var Ports = map[string]func(n int64) any{
	"core/calls":   func(n int64) any { return core.Calls(n) },
	"core/fib":     func(n int64) any { return core.Fib(n) },
	"core/lambdas": func(n int64) any { return core.Lambdas(n) },
	"core/loop":    func(n int64) any { return core.Loop(n) },
}
