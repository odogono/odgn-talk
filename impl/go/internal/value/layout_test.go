package value

import (
	"reflect"
	"testing"
	"unsafe"
)

// A Nothing List is charged only 16 bytes per slot. Wide inline metadata can
// exhaust wasm32 before the conformance-minimum Allocation Budget faults.
func TestValueContainerSlotSize(t *testing.T) {
	if size := unsafe.Sizeof(Value{}); size > 32 {
		t.Fatalf("container slot is %d bytes, want at most 32", size)
	}
	if reflect.TypeFor[Value]().Comparable() {
		t.Fatal("Values with slice payloads must not be used as reference-map keys")
	}
}
