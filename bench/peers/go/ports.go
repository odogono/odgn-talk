// Package peers holds the Benchmark Suite's native Go ports: idiomatic Go
// counterparts of the Benchmark Scripts, the ceiling for the Go Core.
package peers

import (
	"github.com/odogono/odgn-talk/bench/peers/go/collections"
	"github.com/odogono/odgn-talk/bench/peers/go/core"
	"github.com/odogono/odgn-talk/bench/peers/go/macro"
	"github.com/odogono/odgn-talk/bench/peers/go/numbers"
	"github.com/odogono/odgn-talk/bench/peers/go/text"
)

// Ports maps each Benchmark's name to its port, which returns the value the
// Script's `run n` returns.
var Ports = map[string]func(n int64) any{
	"numbers/add":             numbers.Add,
	"numbers/multiply":        numbers.Multiply,
	"numbers/divide":          numbers.Divide,
	"numbers/quantity":        numbers.Quantity,
	"text/build":              text.Build,
	"text/iterate":            text.Iterate,
	"text/index":              text.Index,
	"text/patterns":           text.Patterns,
	"collections/list-build":  collections.ListBuild,
	"collections/map-build":   collections.MapBuild,
	"collections/list-update": collections.ListUpdate,
	"collections/map-update":  collections.MapUpdate,
	"collections/iterate":     collections.Iterate,
	"macro/transform":         macro.Transform,
	"macro/report":            macro.Report,
	"macro/game-tick":         macro.GameTick,

	"core/calls":   func(n int64) any { return core.Calls(n) },
	"core/fib":     func(n int64) any { return core.Fib(n) },
	"core/lambdas": func(n int64) any { return core.Lambdas(n) },
	"core/loop":    func(n int64) any { return core.Loop(n) },
}
