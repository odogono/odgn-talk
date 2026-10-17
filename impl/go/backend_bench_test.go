package northtalk_test

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// The benchmarks in this file measure the Core behind the public API, with no
// build tag, so the same code compares native Go with the Zig adapter (#1054).
// The Benchmark Suite in bench/go covers Load, Restore, warm execution, and
// Capability and conversion workloads; zig-adapter-bench.sh runs both.

var backendNow = time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)

// latencies records one duration per iteration and reports percentiles.
type latencies []time.Duration

func (l latencies) report(b *testing.B) {
	if len(l) == 0 {
		return
	}
	slices.Sort(l)
	at := func(p float64) float64 { return float64(l[min(len(l)-1, int(p*float64(len(l))))].Nanoseconds()) }
	b.ReportMetric(at(0.50), "p50-ns")
	b.ReportMetric(at(0.99), "p99-ns")
}

// requestOnce sends m to s, pumps once and checks the result.
func requestOnce(g *talk.Group, s *talk.Script, m talk.Message, want talk.Value) error {
	_, p, err := s.Request(context.Background(), m)
	if err != nil {
		return err
	}
	if _, err = g.Pump(backendNow, talk.PumpOptions{}); err != nil {
		return err
	}
	if v, failure := p.Result(); failure != nil || !v.Equal(want) {
		return fmt.Errorf("result %v, failure %v", v, failure)
	}
	return nil
}

// BenchmarkBackendRequest is the smallest Host round trip: Request, one Pump
// and the result of an immediate Handler, with tail latency.
func BenchmarkBackendRequest(b *testing.B) {
	g := talk.New().NewGroup(talk.GroupOptions{Name: "request"})
	s, err := g.Load(talk.LoadOptions{Name: "s", Source: "on ping n\n return n + 1\nend ping\n"})
	if err != nil {
		b.Fatal(err)
	}
	m := talk.Message{Name: "ping", Args: []talk.Value{talk.Int(41)}}
	times := make(latencies, 0, 1<<16)
	b.ReportAllocs()
	for b.Loop() {
		start := time.Now()
		if err := requestOnce(g, s, m, talk.Int(42)); err != nil {
			b.Fatal(err)
		}
		times = append(times, time.Since(start))
	}
	times.report(b)
}

// BenchmarkBackendDeferredCall suspends on an Operation that another
// goroutine answers after Start has returned. The Host waits for OnReady and
// pumps again, as a real asynchronous Host does. The history is how many
// calls the Group settled before timing starts, which shows whether a call's
// cost grows with the Group's age.
func BenchmarkBackendDeferredCall(b *testing.B) {
	for _, history := range []int{0, 5000} {
		b.Run(fmt.Sprintf("history=%d", history), func(b *testing.B) {
			core := talk.New()
			started := make(chan *talk.Call, 1)
			go func() {
				for c := range started {
					c.Answer(talk.Int(41))
				}
			}()
			defer close(started)
			def, err := core.DefineCapability("api", talk.Operation{
				Name: "read", Mode: talk.Suspending, Result: talk.NumberShape,
				Start: func(c *talk.Call, _ []talk.Value) error { started <- c; return nil },
			})
			if err != nil {
				b.Fatal(err)
			}
			ready := make(chan struct{}, 1)
			g := core.NewGroup(talk.GroupOptions{Name: "deferred", OnReady: func() {
				select {
				case ready <- struct{}{}:
				default:
				}
			}})
			s, err := g.Load(talk.LoadOptions{Name: "s", Source: "on go\n ask api to read and wait\n return it + 1\nend go\n", Grants: map[string]*talk.Grant{"api": def.GrantAll(nil)}})
			if err != nil {
				b.Fatal(err)
			}
			for range history {
				if err := deferredRequest(g, s, ready); err != nil {
					b.Fatal(err)
				}
			}
			times := make(latencies, 0, 1<<16)
			b.ReportAllocs()
			b.ResetTimer()
			for b.Loop() {
				start := time.Now()
				if err := deferredRequest(g, s, ready); err != nil {
					b.Fatal(err)
				}
				times = append(times, time.Since(start))
			}
			times.report(b)
		})
	}
}

// deferredRequest pumps until the Request settles, waiting for OnReady
// between Pumps.
func deferredRequest(g *talk.Group, s *talk.Script, ready chan struct{}) error {
	_, p, err := s.Request(context.Background(), talk.Message{Name: "go"})
	if err != nil {
		return err
	}
	for {
		select {
		case <-ready:
		default:
		}
		if _, err = g.Pump(backendNow, talk.PumpOptions{}); err != nil {
			return err
		}
		select {
		case <-p.Done():
			if v, failure := p.Result(); failure != nil || !v.Equal(talk.Int(42)) {
				return fmt.Errorf("result %v, failure %v", v, failure)
			}
			return nil
		case <-ready:
		}
	}
}

// throughputSource does a little Script work and one immediate Capability
// call per Request, so neither the Pump nor the crossing dominates.
const throughputSource = `on go n
 put 0 into total
 repeat for each i in 1..n
  add i to total
 end repeat
 ask api to read total
 return it
end go
`

// BenchmarkBackendMultiGroup runs independent Groups, one goroutine each,
// sharing one Core. It reports aggregate Requests per second and the
// per-Request tail latency across all Groups.
func BenchmarkBackendMultiGroup(b *testing.B) {
	for _, groups := range []int{1, 4, 16} {
		b.Run(fmt.Sprintf("groups=%d", groups), func(b *testing.B) {
			core := talk.New()
			def, err := core.DefineCapability("api", talk.Operation{
				Name: "read", Mode: talk.Immediate, Args: []talk.Shape{talk.NumberShape}, Result: talk.NumberShape,
				Do: func(_ *talk.Call, args []talk.Value) (talk.Value, error) { return args[0], nil },
			})
			if err != nil {
				b.Fatal(err)
			}
			type worker struct {
				g     *talk.Group
				s     *talk.Script
				times latencies
			}
			workers := make([]*worker, groups)
			for i := range workers {
				g := core.NewGroup(talk.GroupOptions{Name: fmt.Sprint("tenant", i)})
				s, err := g.Load(talk.LoadOptions{Name: "s", Source: throughputSource, Grants: map[string]*talk.Grant{"api": def.GrantAll(nil)}})
				if err != nil {
					b.Fatal(err)
				}
				workers[i] = &worker{g: g, s: s, times: make(latencies, 0, 1<<14)}
			}
			m := talk.Message{Name: "go", Args: []talk.Value{talk.Int(20)}}
			want := talk.Int(210)
			b.ReportAllocs()
			b.ResetTimer()
			var next atomic.Int64
			var wg sync.WaitGroup
			for _, w := range workers {
				wg.Go(func() {
					for next.Add(1) <= int64(b.N) {
						start := time.Now()
						if err := requestOnce(w.g, w.s, m, want); err != nil {
							b.Error(err)
							return
						}
						w.times = append(w.times, time.Since(start))
					}
				})
			}
			wg.Wait()
			b.StopTimer()
			b.ReportMetric(float64(b.N)/b.Elapsed().Seconds(), "req/s")
			var all latencies
			for _, w := range workers {
				all = append(all, w.times...)
			}
			all.report(b)
		})
	}
}

// BenchmarkBackendRetainedMemory reports the live Go heap each loaded Group
// adds, with a filled Script Variable, while every Group stays held. The Zig
// adapter keeps guest linear memory on the Go heap (zigwasm.linearMemory), so
// the figure includes it; wazero's compiled code is shared per process and
// is not counted. Each iteration measures a fresh Core: it warms 64 Groups
// first, which pay one-time costs such as the guests a Core's Groups share,
// then measures many more, so guest memory growth averages out (#1103).
func BenchmarkBackendRetainedMemory(b *testing.B) {
	const warm, groups = 64, 256
	const source = `script variable rows = []
on fill n
 repeat for each i in 1..n
  put {id: i, name: "row " & i} after rows
 end repeat
 return n
end fill
`
	var heap float64
	for b.Loop() {
		core := talk.New()
		var held []*talk.Group
		for range warm {
			held = append(held, core.NewGroup(talk.GroupOptions{Name: "warm"}))
		}
		before := settledHeap()
		for i := range groups {
			g := core.NewGroup(talk.GroupOptions{Name: fmt.Sprint("held", i)})
			s, err := g.Load(talk.LoadOptions{Name: "s", Source: source})
			if err != nil {
				b.Fatal(err)
			}
			m := talk.Message{Name: "fill", Args: []talk.Value{talk.Int(100)}}
			if err := requestOnce(g, s, m, talk.Int(100)); err != nil {
				b.Fatal(err)
			}
			held = append(held, g)
		}
		after := settledHeap()
		runtime.KeepAlive(core)
		runtime.KeepAlive(held)
		heap += float64(after-before) / groups
	}
	b.ReportMetric(heap/float64(b.N), "heap-B/group")
}

// settledHeap collects until the live heap stops changing and returns it.
// runtime.GC returns before cleanups run, and the Zig adapter frees a
// collected Group's guest in a cleanup, so a Core from an earlier iteration
// would otherwise be freed partway through a later measurement.
func settledHeap() int64 {
	var s runtime.MemStats
	last := int64(-1)
	for range 50 {
		runtime.GC()
		time.Sleep(time.Millisecond)
		runtime.ReadMemStats(&s)
		if int64(s.HeapAlloc) == last {
			break
		}
		last = int64(s.HeapAlloc)
	}
	return last
}

const coldChildEnv = "NORTHTALK_COLD_START_CHILD"

// BenchmarkBackendColdStart starts a fresh process per iteration, so nothing
// compiled in memory is shared. The child times its first Group from New to
// the first Request result, then a second Group on the same Core, which shares
// any compiled code. Process time includes the test binary's own start. With
// cache=warm the children share a Zig compilation cache directory, filled by
// an untimed child first; native Go ignores it (#1103).
func BenchmarkBackendColdStart(b *testing.B) {
	for _, cache := range []string{"none", "warm"} {
		b.Run("cache="+cache, func(b *testing.B) {
			env := append(os.Environ(), coldChildEnv+"=1")
			if cache == "warm" {
				env = append(env, "NORTHTALK_ZIG_CACHE_DIR="+b.TempDir())
				if _, _, err := coldChild(env); err != nil {
					b.Fatal(err)
				}
			}
			var first, second, process float64
			for b.Loop() {
				start := time.Now()
				f, s, err := coldChild(env)
				if err != nil {
					b.Fatal(err)
				}
				process += float64(time.Since(start).Nanoseconds())
				first += f
				second += s
			}
			n := float64(b.N)
			b.ReportMetric(first/n, "first-group-ns")
			b.ReportMetric(second/n, "second-group-ns")
			b.ReportMetric(process/n, "process-ns")
		})
	}
}

// coldChild runs TestBackendColdStartChild in a new process and returns its
// first and second Group times.
func coldChild(env []string) (first, second float64, err error) {
	cmd := exec.Command(os.Args[0], "-test.run=^TestBackendColdStartChild$", "-test.count=1")
	cmd.Env = env
	out, err := cmd.Output()
	if err != nil {
		return 0, 0, fmt.Errorf("%w: %s", err, out)
	}
	_, err = fmt.Sscanf(lineWith(string(out), "cold-start "), "cold-start %g %g", &first, &second)
	return first, second, err
}
func lineWith(out, prefix string) string {
	for line := range strings.Lines(out) {
		if strings.HasPrefix(line, prefix) {
			return line
		}
	}
	return ""
}

func TestBackendColdStartChild(t *testing.T) {
	if os.Getenv(coldChildEnv) == "" {
		t.Skip("run by BenchmarkBackendColdStart")
	}
	group := func(core *talk.Core) time.Duration {
		start := time.Now()
		g := core.NewGroup(talk.GroupOptions{Name: "cold"})
		s, err := g.Load(talk.LoadOptions{Name: "s", Source: "on ping n\n return n + 1\nend ping\n"})
		if err != nil {
			t.Fatal(err)
		}
		_, p, err := s.Request(context.Background(), talk.Message{Name: "ping", Args: []talk.Value{talk.Int(1)}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = g.Pump(backendNow, talk.PumpOptions{}); err != nil {
			t.Fatal(err)
		}
		if v, failure := p.Result(); failure != nil || !v.Equal(talk.Int(2)) {
			t.Fatal(v, failure)
		}
		return time.Since(start)
	}
	core := talk.New()
	first := group(core)
	second := group(core)
	fmt.Printf("cold-start %d %d\n", first.Nanoseconds(), second.Nanoseconds())
}
