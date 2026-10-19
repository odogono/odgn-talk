package northtalk

import (
	"context"
	"testing"
	"time"
)

// A Library Handler's `wait for` observes the calling Run's Script, testing
// its Guard from the Library's own code unit (ADR 0113).
func TestLibraryWaitForObservesCallingScript(t *testing.T) {
	c := New()
	l, err := c.CompileLibrary(LibrarySource{Name: "dialogue", Source: `constant yes = "Y"
on confirm within
 wait for
  when pressed key where key = yes then
   return true
  after within then
   return false
 end wait
end confirm
`}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	if err := g.AddLibrary(l); err != nil {
		t.Fatal(err)
	}
	s, err := g.Load(LoadOptions{Name: "s", Source: "use confirm from dialogue\non buy\n confirm 5 s and wait\n return it\nend buy\non pressed key\nend pressed\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, yes, _ := s.Request(context.Background(), Message{Name: "buy"})
	_, late, _ := s.Request(context.Background(), Message{Name: "buy"})
	now := time.Unix(0, 0)
	if _, err := g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	n, _ := Text("N")
	y, _ := Text("Y")
	s.Deliver(Message{Name: "pressed", Args: []Value{n}})
	s.Deliver(Message{Name: "pressed", Args: []Value{y}})
	if _, err := g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	for _, p := range []*Pending{yes, late} {
		if v, failure := p.Result(); failure != nil || !v.Equal(Bool(true)) {
			t.Fatalf("%v, %v", v, failure)
		}
	}
	_, timeout, _ := s.Request(context.Background(), Message{Name: "buy"})
	if _, err := g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(now.Add(5*time.Second), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if v, failure := timeout.Result(); failure != nil || !v.Equal(Bool(false)) {
		t.Fatalf("%v, %v", v, failure)
	}
}
