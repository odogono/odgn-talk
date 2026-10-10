package machine

import "github.com/odogono/odgn-talk/impl/go/internal/value"

// Fold comparisons, never stored map keys: two distinct keys can have the
// same fold. Match entries one-to-one so equality remains reflexive and
// insensitive to insertion order even for such maps.
func equal(a, b value.Value, folded bool) bool {
	if !folded {
		return a.Equal(b)
	}
	if a.Kind != b.Kind {
		return false
	}
	switch a.Kind {
	case value.Text:
		return fold(a).Text() == fold(b).Text()
	case value.List, value.Range:
		if len(a.Items()) != len(b.Items()) {
			return false
		}
		for j, x := range a.Items() {
			if !equal(x, b.Items()[j], true) {
				return false
			}
		}
		return true
	case value.Map:
		if len(a.Entries()) != len(b.Entries()) {
			return false
		}
		matches, _ := compareMap(a, b, true)
		return matches
	case value.Function:
		if a.Function() == nil || b.Function() == nil {
			return false
		}
		x, y := *a.Function(), *b.Function()
		capturesA, capturesB := x.Captures, y.Captures
		x.Captures, y.Captures = nil, nil
		a = a.WithFunction(&x)
		b = b.WithFunction(&y)
		return a.Equal(b) && equal(value.Fields{Kind: value.Map, Entries: capturesA}.Value(), value.Fields{Kind: value.Map, Entries: capturesB}.Value(), true)
	}
	return a.Equal(b)
}

// compareMap supplies both equality and its Cost Model scanned count. The
// insertion order of the left map determines the first differing entry.
func compareMap(a, b value.Value, folded bool) (bool, int64) {
	used := make([]bool, len(b.Entries()))
	for i, p := range a.Entries() {
		if i >= len(b.Entries()) {
			return false, int64(i)
		}
		found := false
		for j, q := range b.Entries() {
			if !used[j] && equal(text(p.Key), text(q.Key), folded) && equal(p.Val, q.Val, folded) {
				used[j], found = true, true
				break
			}
		}
		if !found {
			return false, int64(i + 1)
		}
	}
	return len(a.Entries()) == len(b.Entries()), int64(len(a.Entries()))
}
