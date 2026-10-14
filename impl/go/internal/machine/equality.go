package machine

import "github.com/odogono/odgn-talk/impl/go/internal/value"

// equal is Script equality under one fresh Comparer; loops that compare
// repeatedly share a Comparer of their own (#890).
func equal(a, b value.Value, folded bool) bool {
	return value.NewComparer(folded).Equal(a, b)
}
