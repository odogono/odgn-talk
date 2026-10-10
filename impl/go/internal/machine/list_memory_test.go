package machine

import (
	"fmt"
	"runtime"
	"runtime/debug"
	"strings"
	"testing"
)

// Exercise Script growth, including the transient buffers that survive until
// collection. Keep this test serial: heap measurements are process-wide.
func TestListGrowthMemory(t *testing.T) {
	previousGC := debug.SetGCPercent(100)
	t.Cleanup(func() { debug.SetGCPercent(previousGC) })
	const budget = 4 << 20
	for _, item := range []string{`"` + strings.Repeat("x", 64) + `"`, "nothing"} {
		t.Run(item, func(t *testing.T) {
			source := fmt.Sprintf("on go\n put [] into xs\n repeat forever\n put %s after xs\n end repeat\nend go\n", item)
			state, err := Initialize(compile(t, source))
			if err != nil {
				t.Fatal(err)
			}
			run := StartDelivery(state, "go", nil, Limits{Fuel: 1 << 30, Alloc: budget, Depth: 100}, false)
			run.PolicyDispatch = false
			runtime.GC()
			var stats runtime.MemStats
			runtime.ReadMemStats(&stats)
			baseline, peak := stats.HeapAlloc, stats.HeapAlloc
			for run.Status == Running || run.Status == Preempted {
				run.Execute(1000)
				runtime.ReadMemStats(&stats)
				peak = max(peak, stats.HeapAlloc)
			}
			if run.Status != Faulted || run.Limit != "alloc" {
				t.Fatalf("status=%v limit=%s", run.Status, run.Limit)
			}
			t.Logf("budget=%d peak heap growth=%d (%.2fx)", budget, peak-baseline, float64(peak-baseline)/budget)
			if peak-baseline > 12*budget {
				t.Fatalf("List growth exceeded 12x Allocation Budget")
			}
			runtime.KeepAlive(run)
		})
	}
}
