package northtalk

import (
	"errors"
	"strings"
	"testing"
)

// labelledWorld defines `world` with an immediate `move` of two texts, with
// the given labels, a Host Command when command is set.
func labelledWorld(t *testing.T, c *Core, labels []string, command bool, seen *[]string) *CapabilityDef {
	t.Helper()
	def, err := c.DefineCapability("world", Operation{Name: "move", Mode: Immediate, Args: []Shape{TextShape, TextShape}, Labels: labels, Result: TextShape, Command: command, Do: func(_ *Call, args []Value) (Value, error) {
		*seen = append(*seen, args[0].String()+" "+args[1].String())
		return args[1], nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	return def
}

// `labels` has one Argument Label word per argument after the first, or is
// empty (ADR 0115); anything else is `invalid value`.
func TestDefineCapabilityChecksLabels(t *testing.T) {
	c := New()
	do := func(*Call, []Value) (Value, error) { return Nothing, nil }
	two := []Shape{TextShape, TextShape}
	for _, tc := range []struct {
		args   []Shape
		labels []string
		ok     bool
	}{
		{two, []string{"to"}, true},
		{two, []string{"toward"}, true},
		{two, []string{}, true},
		{nil, nil, true},
		{[]Shape{TextShape, TextShape, NumberShape}, []string{"across", "by"}, true},
		{two, []string{"to", "by"}, false},
		{[]Shape{TextShape, TextShape, NumberShape}, []string{"to"}, false},
		{[]Shape{TextShape}, []string{"to"}, false},
		{two, []string{"from"}, false},
		{two, []string{"with"}, false},
		{two, []string{"otherwise"}, false},
		{two, []string{"into"}, false},
		{two, []string{"and"}, false},
		{two, []string{""}, false},
		{two, []string{"two words"}, false},
		{two, []string{"to:"}, false},
	} {
		_, err := c.DefineCapability("x", Operation{Name: "op", Mode: Immediate, Args: tc.args, Labels: tc.labels, Do: do})
		var host *HostError
		if tc.ok && err != nil || !tc.ok && (!errors.As(err, &host) || host.Code != InvalidValue) {
			t.Errorf("%v: %v", tc.labels, err)
		}
	}
}

// A labelled call is the positional call: the same Host function sees the
// same arguments (ADR 0115). A labelled Host Command and its positional
// spelling call it too.
func TestLabelledCallsCallTheOperation(t *testing.T) {
	c := New()
	var seen []string
	world := labelledWorld(t, c, []string{"to"}, true, &seen)
	g := c.NewGroup(GroupOptions{Name: "g"})
	source := "on go\n ask world to move \"a\" to \"b\"\n ask world to move \"c\", \"d\"\n move \"e\" to \"f\"\n move \"g\", \"h\"\n return it\nend go"
	s, err := g.Load(LoadOptions{Name: "s", Source: source, Grants: map[string]*Grant{"world": world.GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	if v := runHostCommands(t, g, s); v.String() != `"h"` || strings.Join(seen, ",") != `"a" "b","c" "d","e" "f","g" "h"` {
		t.Fatalf("%v %v", v, seen)
	}
}

// A Library's labelled call is checked against its compilation
// declarations, and again at an importer's `use` line against the
// importer's.
func TestLibraryLabelledCallsRechecked(t *testing.T) {
	c := New()
	src := LibrarySource{Name: "router", Version: "1", Source: "on route a, b\n ask world to move a to b\n return it\nend route\n"}
	two := []Shape{TextShape, TextShape}
	if _, err := c.CompileLibrary(src, nil, GrantDecls{"world": {"move": {Mode: Immediate, Args: two}}}); err == nil || !strings.Contains(err.Error(), "wrong labels") {
		t.Fatalf("without labels: %v", err)
	}
	l, err := c.CompileLibrary(src, nil, GrantDecls{"world": {"move": {Mode: Immediate, Args: two, Labels: []string{"to"}}}})
	if err != nil {
		t.Fatal(err)
	}
	var seen []string
	for _, tc := range []struct {
		labels []string
		ok     bool
	}{{[]string{"to"}, true}, {[]string{"toward"}, false}, {nil, false}} {
		c := New()
		g := c.NewGroup(GroupOptions{Name: "g"})
		if err := g.AddLibrary(l); err != nil {
			t.Fatal(err)
		}
		world := labelledWorld(t, c, tc.labels, false, &seen)
		_, err := g.Load(LoadOptions{Name: "s", Source: "use route from router\n", Grants: map[string]*Grant{"world": world.GrantAll(nil)}})
		var load *LoadError
		if tc.ok && err != nil || !tc.ok && (!errors.As(err, &load) || load.Diagnostics[0].Code != "wrong labels" || load.Diagnostics[0].Line != 1) {
			t.Errorf("%v: %v", tc.labels, err)
		}
	}
}

// `labels` is part of the Operation Data: the Fingerprint writes it after
// `args`, only when it isn't empty, and restore matching compares it, so a
// labels-only change is a declaration mismatch.
func TestLabelsInFingerprintAndRestore(t *testing.T) {
	var seen []string
	c := New()
	labelled := labelledWorld(t, c, []string{"to"}, false, &seen)
	toward := labelledWorld(t, c, []string{"toward"}, false, &seen)
	plain := labelledWorld(t, c, []string{}, false, &seen)
	g := c.NewGroup(GroupOptions{Name: "g"})
	if _, err := g.Load(LoadOptions{Name: "s", Source: "on go\n ask world to move \"a\", \"b\"\nend go", Grants: map[string]*Grant{"world": labelled.GrantAll(nil)}}); err != nil {
		t.Fatal(err)
	}
	saved, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	for _, other := range []*CapabilityDef{toward, plain} {
		_, _, err = c.Restore(saved, RestoreOptions{Mismatch: RejectMismatch, Grants: func(string, string) *Grant { return other.GrantAll(nil) }})
		var host *HostError
		if !errors.As(err, &host) || host.Code != SaveMismatch {
			t.Fatalf("restore with other labels: %v", err)
		}
	}
	restored, _, err := c.Restore(saved, RestoreOptions{Mismatch: RejectMismatch, Grants: func(string, string) *Grant { return labelled.GrantAll(nil) }})
	if err != nil {
		t.Fatal(err)
	}
	if restored.Fingerprint() != g.Fingerprint() {
		t.Fatal("restored Fingerprint differs")
	}
	// An unbound restore keeps the saved declarations, labels included.
	unbound, _, err := c.Restore(saved, RestoreOptions{Mismatch: RejectMismatch})
	if err != nil {
		t.Fatal(err)
	}
	if unbound.Fingerprint() != g.Fingerprint() {
		t.Fatal("unbound restore Fingerprint differs")
	}
}
