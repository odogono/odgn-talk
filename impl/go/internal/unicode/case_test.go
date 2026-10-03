package unicode

import "testing"

func TestPinnedFullCaseMappings(t *testing.T) {
	for _, tc := range []struct {
		text, want string
		upper      bool
	}{
		{"Straße", "STRASSE", true}, {"ΟΔΟΣ", "οδος", false},
		{"AΣ AΣA", "aς aσa", false}, {"AΣ\u0301!", "aς\u0301!", false},
		{"İ", "i\u0307", false}, {"\u0345", "Ι", true},
	} {
		got, e := Case(tc.text, tc.upper)
		if e != nil || got != tc.want {
			t.Fatalf("Case(%q,%v)=%q %v; want%q", tc.text, tc.upper, got, e, tc.want)
		}
	}
	if _, e := Case(string([]byte{255}), true); e == nil {
		t.Fatal("invalid UTF-8 accepted")
	}
}
