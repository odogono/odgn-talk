package northtalk

import (
	"context"
	"errors"
	"testing"
	"time"
)

// runEnds returns a Pump's run end reports, in order.
func runEnds(r PumpResult) []*RunEnd {
	var out []*RunEnd
	for _, report := range r.Reports {
		if end, ok := report.(*RunEnd); ok {
			out = append(out, end)
		}
	}
	return out
}

// A Session Script may be extended with a Fallback, which then takes the
// messages no clause in any code unit matches. A second Fallback in a later
// unit reuses the name `any message`, as a second Handler would (ADR 0063).
func TestExtendWithFallbackHandler(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on greet who where who is \"Ann\"\n return \"hello\"\nend greet"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Extend("on any message m\n return the name of m & \"?\"\nend any message"); err != nil {
		t.Fatal(err)
	}
	_, p, err := s.Request(context.Background(), Message{Name: "greet", Args: []Value{mustValue(t, `"Bob"`)}})
	if err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if v, failure := p.Result(); failure != nil || v.String() != `"greet?"` {
		t.Fatal(v, failure)
	}
	ends := runEnds(r)
	if len(ends) != 1 || !ends[0].Fallback || ends[0].Handler != "greet" {
		t.Fatal(ends)
	}
	err = s.Extend("on any message m\n return 2\nend")
	var hostErr *HostError
	if !errors.As(err, &hostErr) || hostErr.Code != NameReused {
		t.Fatal(err)
	}
}

// A local Command Call never falls back, and a Script whose only Handler
// is a Fallback doesn't want a Broadcast.
func TestFallbackExclusions(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on greet x where x is 1\nend greet\non go\n greet 2\nend go\non any message m\n return 9\nend"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Load(LoadOptions{Name: "only", Source: "on any message m\n return 9\nend"}); err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	if _, err := g.Broadcast(Message{Name: "zap"}); err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	ends := runEnds(r)
	if len(ends) != 1 || ends[0].Outcome != Errored || ends[0].Error.Code != "no match" || ends[0].Fallback {
		t.Fatal(ends)
	}
}

// A Decision that a child's non-deciding clause allowed and then passed
// still skips its parent's Fallback.
func TestDecisionNeverReachesFallback(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	kind := objectKindForTest(t, c, "room")
	parent, _ := g.Object(kind, "parent", nil)
	leaf, _ := g.Object(kind, "leaf", nil)
	if _, err := g.Load(LoadOptions{Name: "parent", Owner: parent, Source: "script variable seen = 0\non any message m\n add 1 to seen\nend"}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Load(LoadOptions{Name: "leaf", Owner: leaf, Source: "on open\n pass open\nend open"}); err != nil {
		t.Fatal(err)
	}
	if err := g.SetParent(leaf, parent); err != nil {
		t.Fatal(err)
	}
	if _, _, err := g.Decide(context.Background(), leaf, Message{Name: "open"}); err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, end := range runEnds(r) {
		if end.Fallback {
			t.Fatal(end)
		}
	}
	if got := g.Inspect().Scripts[0].Vars[0].Val.String(); got != "0" {
		t.Fatalf("seen = %s", got)
	}
}

// A suspended Fallback Run is saved and restored as any Run is, and keeps
// its Selector and `fallback` flag. Inspect shows the Selector.
func TestSaveRestoresSuspendedFallbackRun(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on any message {name: n}, queued\n wait 1 s\n return n\nend any message"})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "first"})
	s.Deliver(Message{Name: "second"})
	if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if runs := g.Inspect().Scripts[0].Runs; len(runs) != 2 || runs[0].Handler != "first" || runs[1].Handler != "second" {
		t.Fatal(runs)
	}
	saved, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	restored, _, err := New().Restore(saved, RestoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var ends []*RunEnd
	for second := int64(1); second <= 2; second++ {
		r, err := restored.Pump(time.Unix(second, 0), PumpOptions{})
		if err != nil {
			t.Fatal(err)
		}
		ends = append(ends, runEnds(r)...)
	}
	if len(ends) != 2 || !ends[0].Fallback || ends[0].Handler != "first" || ends[0].Result.String() != `"first"` || !ends[1].Fallback || ends[1].Result.String() != `"second"` {
		t.Fatal(ends)
	}
}

// A Library can't hold a Fallback, since imported Handlers are never entry
// points.
func TestLibraryRejectsFallbackHandler(t *testing.T) {
	_, err := New().CompileLibrary(LibrarySource{Name: "lib", Source: "on any message m\nend"}, nil, nil)
	var load *LoadError
	if !errors.As(err, &load) || len(load.Diagnostics) != 1 || load.Diagnostics[0].Code != "not in a library" || load.Diagnostics[0].Line != 1 || load.Diagnostics[0].Col != 1 {
		t.Fatal(err)
	}
}
