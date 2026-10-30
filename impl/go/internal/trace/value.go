package trace

import (
	"northtalk.org/go/internal/value"
	"slices"
)

// Display omits a Core-generated error message wherever the error is nested.
// Script/Host message fields are ordinary values and remain in the Trace.
func Display(v value.Value) string { return parityValue(v).Display() }
func parityValue(root value.Value) value.Value {
	stack := []*value.Value{&root}
	for len(stack) > 0 {
		v := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		items := slices.Clone(v.Items())
		*v = v.WithItems(items)
		for i := range items {
			stack = append(stack, &items[i])
		}
		if v.Kind == value.Map {
			entries := make([]value.Pair, 0, len(v.Entries()))
			for _, p := range v.Entries() {
				if v.CoreMessage && p.Key == "message" {
					continue
				}
				entries = append(entries, p)
			}
			*v = v.WithEntries(entries)
			for i := range entries {
				stack = append(stack, &entries[i].Val)
			}
		}
	}
	return root
}

// Host displays a northtalk.Value as the Trace does, for the Session Host's
// observation rows. The root package sets it in an init function.
var Host func(value any) string
