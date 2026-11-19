package northtalk

import "testing"

// A load diagnostic carries the range of the token it is reported at, with an
// exclusive end (chapter 2, Syntax errors).
func TestLoadDiagnosticCarriesItsRange(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	_, err := g.Load(LoadOptions{Name: "s", Source: "on go\n  return absent\nend go"})
	load, ok := err.(*LoadError)
	if !ok || len(load.Diagnostics) != 1 {
		t.Fatal(err)
	}
	d := load.Diagnostics[0]
	if got := [4]int{d.Line, d.Col, d.EndLine, d.EndCol}; got != [4]int{2, 10, 2, 16} {
		t.Fatalf("range %v, want [2 10 2 16]", got)
	}
}
