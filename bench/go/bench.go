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
	// Slices are the Fuel Slices of the sweep: Manifest adds one Benchmark
	// for each, named `<name>@slice=<k>`, that pumps with that slice.
	Slices []int64 `json:"slices,omitempty"`
	// Slice is the Fuel Slice of each Pump of a sweep Benchmark. 0: none.
	Slice  int64 `json:"-"`
	script string
}

// Script is the name of the Benchmark's Script: a sweep's runs its base's.
func (b Benchmark) Script() string {
	if b.script != "" {
		return b.script
	}
	return b.Name
}

// Source reads the Benchmark's Script.
func (b Benchmark) Source() (string, error) {
	return readScript(b.Script())
}

func readScript(name string) (string, error) {
	data, e := os.ReadFile(filepath.Join(ScriptsDir, name+".talk"))
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
	var benchmarks []Benchmark
	for _, b := range m.Benchmarks {
		benchmarks = append(benchmarks, b)
		for _, slice := range b.Slices {
			swept := b
			swept.Name, swept.script, swept.Slice, swept.Slices = fmt.Sprintf("%s@slice=%d", b.Name, slice), b.Name, slice, nil
			swept.Skip = map[string]string{"peers": SweepSkip}
			for runner, reason := range b.Skip {
				swept.Skip[runner] = reason
			}
			benchmarks = append(benchmarks, swept)
		}
	}
	return benchmarks, nil
}

// SweepSkip is why the Peer Languages skip a Fuel Slice sweep.
const SweepSkip = "A Fuel Slice is a NorthTalk Pump option; no peer counterpart."

// limits are high enough that no Benchmark trips them: each limit's
// conformance minimum, which every Core supports.
var limits = northtalk.Limits{FuelPerRun: 1_000_000_000, AllocPerRun: 268_435_456, CallDepth: 1_000}

// The Clock reading every Pump uses. Benchmarks never wait on time.
var clock = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

// Loaded is a Benchmark's Script loaded into its own Group, ready to Run.
type Loaded struct {
	core   *northtalk.Core
	group  *northtalk.Group
	script *northtalk.Script
	host   string
	slice  int64
	filled int64 // the `restore` Host: the N its rows were last filled for
}

// Load loads source under name into a new Group, with the Benchmark's Host.
func Load(core *northtalk.Core, b Benchmark, name, source string) (*Loaded, error) {
	g := core.NewGroup(northtalk.GroupOptions{Name: "bench"})
	options := northtalk.LoadOptions{Name: name, Source: source, Limits: limits}
	if e := bindHost(core, g, &options, b.Host); e != nil {
		return nil, e
	}
	s, e := g.Load(options)
	if e != nil {
		return nil, e
	}
	return &Loaded{core: core, group: g, script: s, host: b.Host, slice: b.Slice, filled: -1}, nil
}

// Run delivers `run n` and pumps until its Run ends and the Group is idle,
// returning its report. Under the `restore` Host, the Run is on a Group
// restored from a save of the loaded one.
func (l *Loaded) Run(n int64) (*Report, error) {
	group, script := l.group, l.script
	if l.host == "restore" {
		if l.filled != n {
			if _, e := pump(group, script, "fill", n, 0); e != nil {
				return nil, e
			}
			l.filled = n
		}
		saved, e := group.Save()
		if e != nil {
			return nil, e
		}
		if group, _, e = l.core.Restore(saved, northtalk.RestoreOptions{Name: "bench"}); e != nil {
			return nil, e
		}
		script = group.Script(script.Name())
	}
	return pump(group, script, "run", n, l.slice)
}

// Report is what one Run reported, with the Fuel and allocation of every Run
// the Group's Pumps ended on its way.
type Report struct {
	*northtalk.RunEnd
	Fuel, Alloc int64
}

func pump(group *northtalk.Group, script *northtalk.Script, message string, n, slice int64) (*Report, error) {
	delivery, e := script.Deliver(northtalk.Message{Name: message, Args: []northtalk.Value{northtalk.Int(n)}})
	if e != nil {
		return nil, e
	}
	report := &Report{}
	for {
		result, e := group.Pump(clock, northtalk.PumpOptions{FuelSlice: slice})
		if e != nil {
			return nil, e
		}
		report.Fuel += result.FuelUsed
		for _, r := range result.Reports {
			if end, ok := r.(*northtalk.RunEnd); ok {
				report.Alloc += end.Alloc
				if end.Delivery == delivery {
					report.RunEnd = end
				}
			}
		}
		if result.State == northtalk.Idle && result.NextDeadline.IsZero() && report.RunEnd != nil {
			return report, nil
		}
		// A Pump that does no work can't end the Run: fail instead of hanging.
		if result.FuelUsed == 0 && len(result.Reports) == 0 {
			return nil, fmt.Errorf("the Pump ended no Run")
		}
	}
}

// Check runs the Benchmark once at the chosen size and confirms it completes
// with the expected output, returning its Run report for Fuel and allocation.
func Check(b Benchmark, smoke bool) (*Report, error) {
	source, e := b.Source()
	if e != nil {
		return nil, e
	}
	l, e := Load(northtalk.New(), b, b.Name, source)
	if e != nil {
		return nil, e
	}
	size := b.At(smoke)
	end, e := l.Run(size.N)
	if e != nil {
		return nil, e
	}
	if end.Outcome != northtalk.Completed {
		return nil, fmt.Errorf("%s: Run did not complete: %+v", b.Name, end.RunEnd)
	}
	if got := end.Result.String(); got != size.Expect {
		return nil, fmt.Errorf("%s: output %s, expected %s", b.Name, got, size.Expect)
	}
	return end, nil
}
