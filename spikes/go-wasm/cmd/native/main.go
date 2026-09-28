// The native baseline: the same core workloads, timed like the JS harness
// (one warm-up, then best and median of reps).
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"time"

	"spike/core"
)

type workloads struct {
	Reps int
	VM   [][2]any
	Star [][2]any
}

func main() {
	raw, err := os.ReadFile("workloads.json")
	if err != nil {
		panic(err)
	}
	var w workloads
	if err := json.Unmarshal(raw, &w); err != nil {
		panic(err)
	}
	run := func(suite string, list [][2]any, f func(k, n int32) int64) {
		for k, item := range list {
			n := int32(item[1].(float64))
			res := f(int32(k), n)
			var ms []float64
			for i := 0; i < w.Reps; i++ {
				t := time.Now()
				f(int32(k), n)
				ms = append(ms, float64(time.Since(t).Microseconds())/1000)
			}
			sort.Float64s(ms)
			fmt.Printf("{\"suite\":%q,\"name\":%q,\"n\":%d,\"result\":%d,\"best\":%.2f,\"median\":%.2f}\n",
				suite, item[0], n, res, ms[0], ms[len(ms)/2])
		}
	}
	run("vm", w.VM, core.Bench)
	if core.HasStarlark {
		run("star", w.Star, core.StarBench)
	}
}
