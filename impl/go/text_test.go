package northtalk

import "testing"

func TestHostTextInput(t *testing.T) {
	for _, test := range []struct{ input, want string }{
		{"e\u0301", "é"}, {"\u1100\u1161\u11a8", "각"},
		{"a\u0315\u0300", "à\u0315"}, {"", ""}, {"\ufeff", "\ufeff"},
	} {
		got, err := normalizeHostText(test.input)
		if err != nil || got != test.want {
			t.Fatalf("Host text(%q) = %q, %v; want %q", test.input, got, err, test.want)
		}
	}
	if _, err := normalizeHostText("\xff"); err == nil {
		t.Fatal("Host text accepted invalid UTF-8")
	}
}
