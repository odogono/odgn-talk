package northtalk

import (
	"maps"
	"slices"
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
)

// Each WASI instance pays for a cold compilation; benchmarking the process-wide
// cache would hide that cost after the first iteration.
func BenchmarkColdStandardLibraries(b *testing.B) {
	b.ReportAllocs()
	stdlibMu.Lock()
	defer stdlibMu.Unlock()
	warm := stdlib
	defer func() { stdlib = warm }()
	for b.Loop() {
		stdlib = map[string]*Library{}
		for _, name := range slices.Sorted(maps.Keys(generated.StandardLibraries)) {
			compileStandardLibrary(name)
		}
		if len(stdlib) != 7 {
			b.Fatalf("compiled %d Standard Libraries; want 7", len(stdlib))
		}
	}
}
