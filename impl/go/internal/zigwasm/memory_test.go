package zigwasm

import (
	"bytes"
	"testing"
)

func TestLinearMemoryGrowsInPlaceWithinReserve(t *testing.T) {
	m := allocate(0, 1<<32)
	first := m.Reallocate(23 << 16)
	first[0] = 7
	second := m.Reallocate(33 << 16)
	if &first[0] != &second[0] || len(second) != 33<<16 {
		t.Fatal("growth within the reserve moved or misized the memory")
	}
	third := m.Reallocate(reserve + 1<<16)
	if third[0] != 7 || len(third) != reserve+1<<16 || !bytes.Equal(third[1:33<<16], second[1:]) {
		t.Fatal("growth past the reserve lost contents")
	}
}
