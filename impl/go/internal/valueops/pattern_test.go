package valueops

import "testing"

// Sizes the retired Go parser's compiler gave (#1435); a Pattern's size is
// its chapter 8 program length.
func TestPatternSize(t *testing.T) {
	for _, c := range []struct {
		source string
		size   int
	}{
		{`<"a" or "b", optional digit lazily, 3 words>`, 17},
		{`<n: a number, ",", m: digits as number, line start>`, 17},
		{`<uppercase letter, lowercase letters ignoring case, zero or more of <"ab" or space>>`, 11},
		{`<text>`, 4},
		{`<200000 digits>`, 100001},
	} {
		if got := patternSize(c.source); got != c.size {
			t.Errorf("%s: got %d, want %d", c.source, got, c.size)
		}
	}
}
