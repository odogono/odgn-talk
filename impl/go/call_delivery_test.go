package northtalk

import (
	"strings"
	"testing"
	"time"
)

// A call names the Host Delivery that started its Run, and a Run a Script's
// send started has none (ADR 0125).
func TestCallNamesTheHostDeliveryThatStartedItsRun(t *testing.T) {
	core := New()
	var seen []string
	def, err := core.DefineCapability(t.Name(), Operation{Name: "see", Mode: Immediate, Cost: Cost{Fuel: 1}, Do: func(c *Call, _ []Value) (Value, error) {
		seen = append(seen, string(c.RunID())+" ["+c.Delivery()+"]")
		return Nothing, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	g := core.NewGroup(GroupOptions{Name: "g"})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n ask api to see\n send again to me\nend go\non again\n ask api to see\nend again", Grants: map[string]*Grant{"api": def.GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	id, err := s.Deliver(Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(time.Time{}, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if got, want := strings.Join(seen, ","), "s/r1 ["+string(id)+"],s/r2 []"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}
