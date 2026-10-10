package machine

import (
	"fmt"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
	"testing"
)

var collectionBenchmarkResult value.Value

// Keep the starting collection reachable, as a Script alias/checkpoint would.
// The sizes expose whole-collection copying that tiny update workloads hide.
func BenchmarkCollectionPointWrites(b *testing.B) {
	for _, count := range []int{512, 8192} {
		for _, kind := range []string{"list", "map"} {
			b.Run(fmt.Sprintf("%s/%d", kind, count), func(b *testing.B) {
				items := make([]value.Value, count)
				pairs := make([]value.Pair, count)
				for i := range count {
					items[i] = integer(0)
					pairs[i] = value.Pair{Key: fmt.Sprintf("k%d", i), Val: integer(0)}
				}
				original := value.NewList(items)
				if kind == "map" {
					original, _ = value.NewMap(pairs)
				}
				current := original
				replacement := integer(1)
				_ = Size(original)
				b.ReportAllocs()
				step := 0
				for b.Loop() {
					at := (step * 73) % count
					if kind == "map" {
						current, _ = mapWrite(current, pairs[at].Key, replacement, false)
					} else {
						current, _, _, _ = chunk("chunk-set", "item", integer(int64(at+1)), current, replacement, text(","))
					}
					step++
				}
				collectionBenchmarkResult = current
				if kind == "map" {
					if original.Get("k0").Display() != "0" {
						b.Fatal("retained Map changed")
					}
				} else if original.Items()[0].Display() != "0" {
					b.Fatal("retained List changed")
				}
			})
		}
	}
}
