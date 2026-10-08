package trace

import (
	"github.com/odogono/odgn-talk/impl/go/internal/value"
	"slices"
)

// Display omits a Core-generated error message wherever the error is nested.
// Script/Host message fields are ordinary values and remain in the Trace.
func Display(v value.Value) string { return parityValue(v).Display() }
func parityValue(v value.Value) value.Value {
	v.Items = slices.Clone(v.Items)
	for j, x := range v.Items {
		v.Items[j] = parityValue(x)
	}
	if v.Kind == value.Map {
		entries := make([]value.Pair, 0, len(v.Entries))
		for _, p := range v.Entries {
			if v.CoreMessage && p.Key == "message" {
				continue
			}
			p.Val = parityValue(p.Val)
			entries = append(entries, p)
		}
		v.Entries = entries
	}
	return v
}

// Host displays a northtalk.Value as the Trace does, for the Session Host's
// observation rows. The root package sets it in an init function.
var Host func(value any) string
