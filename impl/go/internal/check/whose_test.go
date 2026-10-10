package check

import (
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"testing"
)

// A Whose Clause's condition calls only Built-ins and holds no Lambda; its
// Whose Key is a key of the chunk, not a name (ADR 0074).
func TestWhoseClauseDiagnostics(t *testing.T) {
	type at struct{ line, col int }
	for _, tc := range []struct {
		source, code string
		want         []at
	}{
		{"function f x\n return x\nend f\non t xs\n return every item of xs whose f(it)\nend t", "not in a whose", []at{{5, 32}}},
		{"on t xs\n return the first item of xs whose min(it, 1) > 0\nend t", "", nil},
		{"on t xs, min\n return every item of xs whose min(it, 1) > 0\nend t", "not in a whose", []at{{2, 32}}},
		// The Lambda is reported once, not the call in its body.
		{"function f x\n return x\nend f\non t xs\n return every item of xs whose [given: f(it)] is not empty\nend t", "not in a whose", []at{{5, 33}}},
		{"function f x\n return x\nend f\non t xs\n return every item of xs whose (every item of it whose f(it)) is not empty\nend t", "not in a whose", []at{{5, 56}}},
		{"on t xs\n return every item of xs whose amount > 1\nend t", "", nil},
		{"on t xs, amount\n return every item of xs whose amount > 1\nend t", "", nil},
		{"on t xs\n return every item of xs whose it > amount\nend t", "unknown name", []at{{2, 37}}},
		{"on t xs\n return every word of xs delimited by \";\" whose it > 1\nend t", "no item chunk", []at{{2, 26}}},
		{"on t xs\n return every item of xs delimited by \";\" whose it > 1\nend t", "", nil},
		{"on t xs\n return every word of item 1 of xs delimited by \";\" whose it > 1\nend t", "", nil},
	} {
		tree, err := syntax.Parse(tc.source)
		if err != nil {
			t.Fatalf("%s: %v", tc.source, err)
		}
		u := Check(tree, Options{})
		var got []at
		for _, d := range u.Diagnostics {
			if d.Code != tc.code {
				t.Errorf("%s: %v", tc.source, u.Diagnostics)
			}
			got = append(got, at{d.Pos.Line, d.Pos.Column})
		}
		if len(got) != len(tc.want) || len(got) > 0 && got[0] != tc.want[0] {
			t.Errorf("%s: %v", tc.source, u.Diagnostics)
		}
	}
}

// An unknown name later in a condition is probably a key spelt without `it's`.
func TestWhoseUnknownNameMessage(t *testing.T) {
	tree, err := syntax.Parse("on t xs\n return every item of xs whose it > region\nend t")
	if err != nil {
		t.Fatal(err)
	}
	u := Check(tree, Options{})
	want := "unknown name: region; a key of the chunk is `it's region`"
	if len(u.Diagnostics) != 1 || u.Diagnostics[0].Message != want {
		t.Fatalf("%v", u.Diagnostics)
	}
}
