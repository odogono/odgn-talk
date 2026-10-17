package machine

import (
	"reflect"
	"testing"
)

func TestRandomGivesTheSpecsSequences(t *testing.T) {
	draws := func(seed uint64, ns ...uint64) []uint64 {
		state := RandomSeedState(seed)
		out := make([]uint64, len(ns))
		for i, n := range ns {
			state, out[i] = nextRandom(state, n)
		}
		return out
	}
	sixes := []uint64{6, 6, 6, 6, 6, 6, 6, 6, 6, 6}
	if got := draws(0, sixes...); !reflect.DeepEqual(got, []uint64{1, 6, 1, 3, 2, 6, 6, 6, 3, 5}) {
		t.Fatalf("seed 0: %v", got)
	}
	if got := draws(42, sixes...); !reflect.DeepEqual(got, []uint64{3, 6, 4, 4, 4, 5, 1, 6, 3, 4}) {
		t.Fatalf("seed 42: %v", got)
	}
	if got := draws(0, 1, 2, 7, 100, randomLimit); !reflect.DeepEqual(got, []uint64{1, 2, 4, 89, 3443325254}) {
		t.Fatalf("bounds: %v", got)
	}
}
