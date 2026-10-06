package bench

import (
	"fmt"
	"os"
	"strings"
	"testing"

	northtalk "github.com/odogono/odgn-talk/impl/go"
)

// smoke runs each Benchmark at its smoke size, as the CI smoke pass does.
var smoke = os.Getenv("NORTHTALK_BENCH_SMOKE") != ""

// filter keeps only the Benchmarks whose names contain it, as `--filter` does.
var filter = os.Getenv("NORTHTALK_BENCH_FILTER")

// manifest returns the Benchmarks the filter selects and the runner doesn't
// skip: "go" for the Go Core, "peers" for the Peer Languages.
func manifest(t testing.TB, runner string) []Benchmark {
	t.Helper()
	benchmarks, e := Manifest()
	if e != nil {
		t.Fatal(e)
	}
	kept := benchmarks[:0]
	for _, b := range benchmarks {
		if _, skip := b.Skip[runner]; !skip && strings.Contains(b.Name, filter) {
			kept = append(kept, b)
		}
	}
	return kept
}

func TestEveryBenchmarkProducesItsExpectedOutput(t *testing.T) {
	for _, b := range manifest(t, "go") {
		t.Run(b.Name, func(t *testing.T) {
			if _, e := Check(b, true); e != nil {
				t.Fatal(e)
			}
		})
	}
}

func TestEveryBenchmarkCanRepeatOnTheSameLoadedScript(t *testing.T) {
	for _, bench := range manifest(t, "go") {
		t.Run(bench.Name, func(t *testing.T) {
			source, err := bench.Source()
			if err != nil {
				t.Fatal(err)
			}
			loaded, err := Load(northtalk.New(), bench.Name, source, bench.Host)
			if err != nil {
				t.Fatal(err)
			}
			first, err := loaded.Run(bench.Smoke.N)
			if err != nil {
				t.Fatal(err)
			}
			second, err := loaded.Run(bench.Smoke.N)
			if err != nil {
				t.Fatal(err)
			}
			if first.Outcome != northtalk.Completed || second.Outcome != northtalk.Completed || first.Result.String() != bench.Smoke.Expect || second.Result.String() != bench.Smoke.Expect || first.Fuel != second.Fuel || first.Alloc != second.Alloc {
				t.Fatalf("repeated Run differs: first=%+v second=%+v", first, second)
			}
		})
	}
}

func TestAWrongExpectedOutputFailsTheCheck(t *testing.T) {
	b := manifest(t, "go")[0]
	b.Smoke.Expect += "0"
	_, e := Check(b, true)
	if e == nil || !strings.Contains(e.Error(), "expected "+b.Smoke.Expect) {
		t.Fatalf("%v", e)
	}
}

// BenchmarkLoad times parsing, checking and lowering a Script into a new
// Group. Each Load uses a fresh name, so the Core's compile cache never hits.
func BenchmarkLoad(b *testing.B) {
	for _, bench := range manifest(b, "go") {
		source, e := bench.Source()
		if e != nil {
			b.Fatal(e)
		}
		b.Run(bench.Name, func(b *testing.B) {
			core := northtalk.New()
			b.ReportAllocs()
			i := 0
			for b.Loop() {
				i++
				if _, e := Load(core, fmt.Sprintf("load%d", i), source, bench.Host); e != nil {
					b.Fatal(e)
				}
			}
		})
	}
}

// BenchmarkRun times one Delivery and all Pumps through RunEnd on an already
// loaded Script, with unlimited Fuel per Pump, and reports Fuel and allocation.
func BenchmarkRun(b *testing.B) {
	for _, bench := range manifest(b, "go") {
		b.Run(bench.Name, func(b *testing.B) {
			checked, e := Check(bench, smoke)
			if e != nil {
				b.Fatal(e)
			}
			source, _ := bench.Source()
			l, e := Load(northtalk.New(), bench.Name, source, bench.Host)
			if e != nil {
				b.Fatal(e)
			}
			n := bench.At(smoke).N
			b.ReportAllocs()
			for b.Loop() {
				if _, e := l.Run(n); e != nil {
					b.Fatal(e)
				}
			}
			b.ReportMetric(float64(checked.Fuel), "fuel/op")
			b.ReportMetric(float64(checked.Alloc), "logical-B/op")
			b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N)/float64(checked.Fuel), "ns/fuel")
		})
	}
}

func TestEveryPeerProducesItsExpectedOutput(t *testing.T) {
	for _, p := range Peers {
		for _, b := range manifest(t, "peers") {
			t.Run(p.Name+"/"+b.Name, func(t *testing.T) {
				if _, e := LoadPeer(p, b, true); e != nil {
					t.Fatal(e)
				}
			})
		}
	}
}

func TestAWrongPeerOutputFailsTheCheck(t *testing.T) {
	b := manifest(t, "peers")[0]
	b.Smoke.Expect += "0"
	for _, p := range Peers {
		_, e := LoadPeer(p, b, true)
		if e == nil || !strings.Contains(e.Error(), "expected "+b.Smoke.Expect) {
			t.Fatalf("%s: %v", p.Name, e)
		}
	}
}

func TestAMissingPortFailsTheCheck(t *testing.T) {
	b := Benchmark{Name: "core/absent"}
	for _, p := range Peers {
		if _, e := LoadPeer(p, b, true); e == nil {
			t.Fatalf("%s loaded a port that doesn't exist", p.Name)
		}
	}
}

// BenchmarkPeer times one Run of each Benchmark's port in each Peer Language
// on the Go Host. Starting the interpreter and compiling the port are not
// part of a Run.
func BenchmarkPeer(b *testing.B) {
	for _, p := range Peers {
		for _, bench := range manifest(b, "peers") {
			b.Run(p.Name+"/"+bench.Name, func(b *testing.B) {
				port, e := LoadPeer(p, bench, smoke)
				if e != nil {
					b.Fatal(e)
				}
				n := bench.At(smoke).N
				b.ReportAllocs()
				for b.Loop() {
					if _, e := port(n); e != nil {
						b.Fatal(e)
					}
				}
			})
		}
	}
}
