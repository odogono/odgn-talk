package bench

import (
	"runtime"
	"testing"

	northtalk "github.com/odogono/odgn-talk/impl/go"
)

// The core ceilings are one tenth of the pre-#322 bytes per full-size Run.
// List construction also guards against the quadratic copying from #503.
// Measure allocation, not timing, so machine speed cannot make CI flaky.
func TestCoreRunAllocationBudgets(t *testing.T) {
	budgets := map[string]struct {
		bytes uint64
		fuel  int64
		alloc int64 // zero leaves the existing core workload's allocation unpinned
	}{
		"core/loop":               {8_750_662, 48_016, 0},
		"core/fib":                {4_066_059, 46_365, 0},
		"core/calls":              {6_343_266, 46_018, 0},
		"core/lambdas":            {10_443_816, 58_027, 0},
		"collections/list-build":  {8_000_000, 19_091, 3_022_112},
		"collections/list-append": {16_000_000, 52_056, 80_200},
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
				if got.Outcome != northtalk.Completed || got.Result.String() != bench.Expect || got.Fuel != budget.fuel || budget.alloc != 0 && got.Alloc != budget.alloc {
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
