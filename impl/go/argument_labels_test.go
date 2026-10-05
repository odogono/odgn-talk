package northtalk

import (
	"context"
	"testing"
	"time"
)

func TestLabelledSelectorsDispatchAndReply(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	a, err := g.Load(LoadOptions{Name: "a", Source: `on go
 send to b: move 3 to 4 and wait
 return it
end go`})
	if err != nil {
		t.Fatal(err)
	}
	_, err = g.Load(LoadOptions{Name: "b", Source: `on move x
 return 99
end move
on move x to y where y = 0
 pass move to
end move
on move x to y
 return x + y
end move`})
	if err != nil {
		t.Fatal(err)
	}
	_, pending, err := a.Request(context.Background(), Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	result, failure := pending.Result()
	if failure != nil || result.String() != "7" {
		t.Fatalf("%v %v trace=%v", result, failure, trace)
	}
}

func TestHostMessageSelectorValidation(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"move:", "move:to", "move::to:", ":to:", "move:from:", "move:with:", "move:in:", "all:to:", "on:to:", "move:_:", "move:to:\n"} {
		_, err := s.Deliver(Message{Name: name, Args: []Value{Int(1), Int(2)}})
		if e, ok := err.(*HostError); !ok || e.Code != InvalidValue {
			t.Fatalf("%q: %v", name, err)
		}
	}
	for _, arity := range []int{0, 1, 3} {
		_, err := s.Deliver(Message{Name: "move:to:", Args: make([]Value, arity)})
		if e, ok := err.(*HostError); !ok || e.Code != InvalidValue {
			t.Fatalf("arity %d: %v", arity, err)
		}
	}
}
