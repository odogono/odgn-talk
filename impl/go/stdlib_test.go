package northtalk

import "testing"

// Each WASI instance pays for a cold compilation; benchmarking the process-wide
// cache would hide that cost after the first iteration.
func BenchmarkColdStandardLibraries(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		if libraries := compileStandardLibraries(); len(libraries) != 7 {
			b.Fatalf("compiled %d Standard Libraries; want 7", len(libraries))
		}
	}
}
