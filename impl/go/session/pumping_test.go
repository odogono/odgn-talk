package session

import (
	"encoding/json"
	"reflect"
	"strconv"
	"testing"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// bellSession's `bell` getter queues a `rang` Delivery each time it is read.
// Each real Clock reading is a second later, and items records the session.
func bellSession(t *testing.T) (*Host, *[]Item) {
	items := &[]Item{}
	clock := time.Unix(0, 0)
	reads := 0
	var objects *Objects
	h := New(Environment{
		Now:    func() time.Time { clock = clock.Add(time.Second); return clock },
		Record: func(i Item) { *items = append(*items, i) },
		Objects: func(c *Objects) map[string]*talk.Object {
			objects = c
			k, err := c.DefineKind(talk.ObjectKindDef{Name: "Bell", Props: []talk.Prop{{Name: "ring", Get: func(*talk.Object) (talk.Value, error) {
				objects.Action(Envelope{"kind": json.RawMessage(`"deliver"`), "to": json.RawMessage(`{"script":"session"}`), "message": json.RawMessage(`{"args":[],"name":"rang"}`)})
				reads++
				return talk.Int(int64(reads)), nil
			}}}})
			if err != nil {
				t.Fatal(err)
			}
			o, err := c.Object(k, "bell", nil)
			if err != nil {
				t.Fatal(err)
			}
			return map[string]*talk.Object{"bell": o}
		},
	})
	return h, items
}

func pumps(items []Item) int {
	n := 0
	for _, i := range items {
		if i.Kind == "clock" {
			n++
		}
	}
	return n
}

// Chapter 12, The foreground: one more Pump, as a Host call of its own.
func TestAGetterThatQueuesADeliveryIsFollowedByOneMorePump(t *testing.T) {
	h, items := bellSession(t)
	h.Input("on rang\nsay \"rang\"\nend rang")
	before := len(*items)
	if out := h.Input("say the ring of bell"); !reflect.DeepEqual(out, []string{"1", "[session/r2] rang"}) {
		t.Fatal(out)
	}
	// The Entry's Pump and lines, then the extra Pump's reading and lines.
	var kinds []string
	for _, i := range (*items)[before:] {
		if i.Kind != "envelope" {
			kinds = append(kinds, i.Kind)
		}
	}
	if want := []string{"input", "clock", "output", "clock", "output"}; !reflect.DeepEqual(kinds, want) {
		t.Fatal(kinds)
	}
}

func TestAHandlerThatReadsTheGetterAgainGetsOneMorePumpPerHostCall(t *testing.T) {
	h, items := bellSession(t)
	h.Input("on rang\nsay \"rang \" & the ring of bell\nend rang")
	before := pumps(*items)
	if out := h.Input("say the ring of bell"); !reflect.DeepEqual(out, []string{"1", "[session/r2] rang 2"}) {
		t.Fatal(out)
	}
	if n := pumps(*items) - before; n != 2 {
		t.Fatal(n)
	}
	// What the extra Pump left queued waits for the next Host call.
	before = pumps(*items)
	if out := h.Input(":runs"); !reflect.DeepEqual(out, []string{"[session/r3] rang 3"}) {
		t.Fatal(out)
	}
	if n := pumps(*items) - before; n != 1 {
		t.Fatal(n)
	}
}

// Store Notifications, The Session Host: Pumps at the same Clock reading.
func TestNotificationsPumpAgainAtTheSameReadingUntilNoneIsLeft(t *testing.T) {
	var items []Item
	clock := time.Unix(0, 0)
	h := New(Environment{
		Now:    func() time.Time { clock = clock.Add(time.Second); return clock },
		Record: func(i Item) { items = append(items, i) },
	})
	h.Input(":grant n store")
	h.Input("on counted change, queued\nask n to get \"k\"\nsay it\nif it < 3 then ask n to set \"k\", it + 1\nend counted")
	h.Input("ask n to watch \"w\", \"k\", \"counted\"")
	before := pumps(items)
	want := []string{}
	for i, run := range []int{3, 4, 5} {
		want = append(want, "[session/r"+strconv.Itoa(run)+"] "+strconv.Itoa(i+1))
	}
	if out := h.Input("ask n to set \"k\", 1"); !reflect.DeepEqual(out, want) {
		t.Fatal(out)
	}
	if n := pumps(items) - before; n != 1 {
		t.Fatal(n)
	}
}
