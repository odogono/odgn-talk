package northtalk

import (
	"context"
	"errors"
	"fmt"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"runtime"
	"strings"
	"testing"
	"time"
)

func hostileSource(kind string, size int) string {
	switch kind {
	case "blank":
		return strings.Repeat("\n", size)
	case "chain":
		return "on sum\nreturn 1" + strings.Repeat(" + 1", size-1) + "\nend sum\n"
	case "power-chain":
		return "on sum\nreturn 1" + strings.Repeat(" ^ 1", size-1) + "\nend sum\n"
	case "distinct-chain":
		var source strings.Builder
		source.WriteString("on sum\nreturn 1")
		for i := 2; i <= size; i++ {
			fmt.Fprintf(&source, " + %d", i)
		}
		source.WriteString("\nend sum\n")
		return source.String()
	case "handlers":
		var source strings.Builder
		for i := 0; i < size; i++ {
			fmt.Fprintf(&source, "on h%d\nend h%d\n", i, i)
		}
		return source.String()
	}
	panic(kind)
}

func TestLoadSourceAllocation(t *testing.T) {
	for _, kind := range []string{"blank", "handlers"} {
		t.Run(kind, func(t *testing.T) {
			size := 1 << 20
			multiplier := uint64(4)
			if kind == "handlers" {
				size = 100000
				multiplier = 128
			}
			source := hostileSource(kind, size)
			g := New().NewGroup(GroupOptions{})
			runtime.GC()
			var before, after runtime.MemStats
			runtime.ReadMemStats(&before)
			if _, err := g.Load(LoadOptions{Name: "hostile", Source: source}); err != nil {
				t.Fatal(err)
			}
			runtime.ReadMemStats(&after)
			// Total allocation bounds the additional live heap even between
			// collections, without a timing-dependent peak sampler.
			allocated := after.TotalAlloc - before.TotalAlloc
			t.Logf("%d source bytes: %d bytes allocated (%.1fx)", len(source), allocated, float64(allocated)/float64(len(source)))
			if allocated > uint64(len(source))*multiplier {
				t.Fatalf("Load allocated more than %d times the source size", multiplier)
			}
			runtime.KeepAlive(g)
		})
	}
}

func TestLoadOperatorChainsWithinNestingLimit(t *testing.T) {
	const terms = syntax.MaxNesting - 3
	for _, kind := range []string{"chain", "distinct-chain", "power-chain"} {
		t.Run(kind, func(t *testing.T) {
			g := New().NewGroup(GroupOptions{})
			s, err := g.Load(LoadOptions{Name: "chain", Source: hostileSource(kind, terms)})
			if err != nil {
				t.Fatal(err)
			}
			_, pending, err := s.Request(context.Background(), Message{Name: "sum"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = g.Pump(time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC), PumpOptions{}); err != nil {
				t.Fatal(err)
			}
			select {
			case <-pending.Done():
			default:
				t.Fatal("chain still running")
			}
			want := int64(terms)
			if kind == "power-chain" {
				want = 1
			}
			if kind == "distinct-chain" {
				want = terms * (terms + 1) / 2
			}
			value, scriptErr := pending.Result()
			if scriptErr != nil || !value.Equal(Int(want)) {
				t.Fatalf("%v %v; want %d", value, scriptErr, want)
			}
		})
	}
}

func TestLoadLongOperatorChainsRespectNestingLimit(t *testing.T) {
	for _, kind := range []string{"chain", "distinct-chain", "power-chain"} {
		t.Run(kind, func(t *testing.T) {
			g := New().NewGroup(GroupOptions{})
			_, err := g.Load(LoadOptions{Name: "chain", Source: hostileSource(kind, 8000)})
			if !isSourceNestingError(err) {
				t.Fatalf("want source nesting refusal, got %v", err)
			}
			if g.Script("chain") != nil {
				t.Fatal("refused Script was registered")
			}
			if _, err := g.Load(LoadOptions{Name: "chain", Source: hostileSource(kind, 3)}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func isSourceNestingError(err error) bool {
	var rejected *LoadError
	return errors.As(err, &rejected) && len(rejected.Diagnostics) == 1 && rejected.Diagnostics[0].Code == "source nesting too deep"
}

func BenchmarkLoadHostileSource(b *testing.B) {
	for _, kind := range []string{"blank", "handlers", "chain", "distinct-chain", "power-chain"} {
		for _, size := range []int{1000, 2000, 4000, 8000, 100000} {
			b.Run(fmt.Sprintf("%s/%d", kind, size), func(b *testing.B) {
				source := hostileSource(kind, size)
				// Exclude the process-wide Standard Library initialization.
				New().NewGroup(GroupOptions{})
				b.ReportAllocs()
				b.SetBytes(int64(len(source)))
				b.ResetTimer()
				for b.Loop() {
					if _, err := New().NewGroup(GroupOptions{}).Load(LoadOptions{Name: "hostile", Source: source}); err != nil && !isSourceNestingError(err) {
						b.Fatal(err)
					}
				}
			})
		}
	}
}
