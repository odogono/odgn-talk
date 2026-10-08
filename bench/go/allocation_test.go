package bench

import (
	"runtime"
	"testing"

	northtalk "github.com/odogono/odgn-talk/impl/go"
)

// These ceilings are one tenth of the pre-#322 bytes per full-size Run.
// Measure allocation, not timing, so machine speed cannot make CI flaky.
func TestCoreRunAllocationBudgets(t *testing.T) {
	budgets := map[string]struct {
		bytes uint64
		fuel  int64
	}{
		"core/loop":    {8_750_662, 48_016},
		"core/fib":     {4_066_059, 46_365},
		"core/calls":   {6_343_266, 46_018},
		"core/lambdas": {10_443_816, 58_027},
	}
	for _, bench := range manifest(t, "go") {
		budget, ok := budgets[bench.Name]
		if !ok {
			continue
		}
		t.Run(bench.Name, func(t *testing.T) {
			source, err := bench.Source()
			if err != nil {
				t.Fatal(err)
			}
			loaded, err := Load(northtalk.New(), bench, bench.Name, source)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := loaded.Run(bench.N); err != nil {
				t.Fatal(err)
			}
			runtime.GC()
			var before, after runtime.MemStats
			runtime.ReadMemStats(&before)
			const repeats = 3
			for range repeats {
				got, err := loaded.Run(bench.N)
				if err != nil {
					t.Fatal(err)
				}
				if got.Outcome != northtalk.Completed || got.Result.String() != bench.Expect || got.Fuel != budget.fuel {
					t.Fatalf("Run output or Fuel changed: %+v", got)
				}
			}
			runtime.ReadMemStats(&after)
			if bytes := (after.TotalAlloc - before.TotalAlloc) / repeats; bytes > budget.bytes {
				t.Fatalf("allocated %d bytes per Run; ceiling is %d", bytes, budget.bytes)
			}
		})
	}
}
