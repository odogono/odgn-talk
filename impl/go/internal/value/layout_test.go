package value

import (
	"reflect"
	"testing"
	"unsafe"
)

// A Nothing List is charged only 16 bytes per slot. Each byte beyond that
// multiplies wasm32 linear memory before the conformance-minimum Allocation
// Budget faults, so collection views share the payload word (#642).
func TestValueContainerSlotSize(t *testing.T) {
	if size := unsafe.Sizeof(Value{}); size > 24 {
		t.Fatalf("container slot is %d bytes, want at most 24", size)
	}
	if reflect.TypeFor[Value]().Comparable() {
		t.Fatal("Values with slice payloads must not be used as reference-map keys")
	}
}
