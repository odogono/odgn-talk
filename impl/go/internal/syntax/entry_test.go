package syntax

import "testing"

func TestEntryParsingAndContinuation(t *testing.T) {
	for _, tc := range []struct {
		source, kind string
		incomplete   bool
	}{
		{"put 1 into n", "statement", false}, {"n + 1", "expression", false}, {"on go\nreturn 1\nend go", "declaration", false},
		{"on go", "", true}, {"[1,", "", true}, {"`first\nsecond", "", true}, {"put 1 + into n", "", false},
		// A `tell` block reads lines until its `end` (ADR 0063).
		{"tell canvas", "", true}, {"tell canvas\nfill 1", "", true}, {"tell canvas\nfill 1\nend tell", "statement", false},
		// `with` before `timeout` starts a Timeout Block (ADR 0073), and
		// `with` alone is still an expression.
		{"with timeout of 1 s", "", true}, {"with timeout of 1 s\nwait 1 s", "", true}, {"with timeout of 1 s\nwait 1 s\nend timeout", "statement", false}, {"with", "expression", false},
	} {
		kind, _, err := ParseEntry(tc.source, nil)
		if err == nil {
			if kind != tc.kind {
				t.Fatal(tc.source, kind)
			}
		} else {
			e, ok := err.(*Error)
			if !ok || e.Incomplete != tc.incomplete {
				t.Fatalf("%q: %v", tc.source, err)
			}
		}
	}
	if kind, _, err := ParseEntry("go and wait", func(n string) bool { return n == "go" }); err != nil || kind != "statement" {
		t.Fatal(kind, err)
	}
	if _, _, err := ParseEntry("1\n2", nil); err == nil {
		t.Fatal("accepted two Entries")
	}
}
