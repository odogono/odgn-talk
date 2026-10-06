// Package bench runs the Benchmark Suite's Scripts on the Go Core. The suite's
// design and its reasons are in ADR 0054; bench/README.md describes how to run it.
package bench

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	northtalk "github.com/odogono/odgn-talk/impl/go"
)

// ScriptsDir holds the shared Benchmark Scripts and their manifest.
var ScriptsDir = filepath.Join("..", "scripts")

// Size is one size a Benchmark runs at and the display form its Run returns.
type Size struct {
	N      int64  `json:"n"`
	Expect string `json:"expect"`
}

// Benchmark is one manifest entry. Its Script is `<name>.talk`, and its
// Handler `run` takes N and returns a value whose display form is Expect.
type Benchmark struct {
	Name string `json:"name"`
	Host string `json:"host,omitempty"`
	Size
	Smoke Size `json:"smoke"`
	// Skip names the runners that can't run it yet, each with the reason.
	Skip map[string]string `json:"skip"`
}

// Source reads the Benchmark's Script.
func (b Benchmark) Source() (string, error) {
	data, e := os.ReadFile(filepath.Join(ScriptsDir, b.Name+".talk"))
	return string(data), e
}

// At returns the size to run: the smoke size when smoke is set.
func (b Benchmark) At(smoke bool) Size {
	if smoke {
		return b.Smoke
	}
	return b.Size
}

// Manifest reads the suite's manifest.
func Manifest() ([]Benchmark, error) {
	data, e := os.ReadFile(filepath.Join(ScriptsDir, "benchmarks.json"))
	if e != nil {
		return nil, e
	}
	var m struct{ Benchmarks []Benchmark }
	if e = json.Unmarshal(data, &m); e != nil {
		return nil, e
	}
	return m.Benchmarks, nil
}

// limits are high enough that no Benchmark trips them: each limit's
// conformance minimum, which every Core supports.
var limits = northtalk.Limits{FuelPerRun: 1_000_000_000, AllocPerRun: 268_435_456, CallDepth: 1_000}

// The Clock reading every Pump uses. Benchmarks never wait on time.
var clock = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

// Loaded is a Benchmark's Script loaded into its own Group, ready to Run.
type Loaded struct {
	group  *northtalk.Group
	script *northtalk.Script
}

// Load loads source under name into a new Group.
func Load(core *northtalk.Core, name, source, host string) (*Loaded, error) {
	g := core.NewGroup(northtalk.GroupOptions{Name: "bench"})
	options := northtalk.LoadOptions{Name: name, Source: source, Limits: limits}
	if e := bindHost(core, g, &options, host); e != nil {
		return nil, e
	}
	s, e := g.Load(options)
	if e != nil {
		return nil, e
	}
	return &Loaded{g, s}, nil
}

// Run delivers `run n` and pumps until the Run ends, returning its report.
func (l *Loaded) Run(n int64) (*northtalk.RunEnd, error) {
	if _, e := l.script.Deliver(northtalk.Message{Name: "run", Args: []northtalk.Value{northtalk.Int(n)}}); e != nil {
		return nil, e
	}
	// An answer queued by Start is consumed by the next Pump. Bound the loop
	// so an unanswerable workload fails instead of hanging.
	for pumps := int64(0); pumps <= n+1; pumps++ {
		result, e := l.group.Pump(clock, northtalk.PumpOptions{})
		if e != nil {
			return nil, e
		}
		for _, r := range result.Reports {
			if end, ok := r.(*northtalk.RunEnd); ok {
				return end, nil
			}
		}
	}
	return nil, fmt.Errorf("the Pump ended no Run")
}

// Check runs the Benchmark once at the chosen size and confirms it completes
// with the expected output, returning its Run report for Fuel and allocation.
func Check(b Benchmark, smoke bool) (*northtalk.RunEnd, error) {
	source, e := b.Source()
	if e != nil {
		return nil, e
	}
	l, e := Load(northtalk.New(), b.Name, source, b.Host)
	if e != nil {
		return nil, e
	}
	size := b.At(smoke)
	end, e := l.Run(size.N)
	if e != nil {
		return nil, e
	}
	if end.Outcome != northtalk.Completed {
		return nil, fmt.Errorf("%s: Run did not complete: %+v", b.Name, end)
	}
	if got := end.Result.String(); got != size.Expect {
		return nil, fmt.Errorf("%s: output %s, expected %s", b.Name, got, size.Expect)
	}
	return end, nil
}
