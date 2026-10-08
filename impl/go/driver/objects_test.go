package driver

import (
	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/session"
	"strings"
	"testing"
	"time"
)

func TestObjectTranscriptRoundTrip(t *testing.T) {
	var items []session.Item
	calls := 0
	h := session.New(session.Environment{Now: func() time.Time { return time.Unix(0, 0) }, Record: func(i session.Item) { items = append(items, i) }, Objects: func(c *session.Objects) map[string]*talk.Object {
		k, err := c.DefineKind(talk.ObjectKindDef{Name: "thing", Props: []talk.Prop{{Name: "x", Shape: talk.AnyShape, GetCost: talk.Cost{Fuel: 2}, Get: func(*talk.Object) (talk.Value, error) { calls++; return talk.Int(3), nil }}}})
		if err != nil {
			t.Fatal(err)
		}
		o, err := c.Object(k, "1", struct{}{})
		if err != nil {
			t.Fatal(err)
		}
		return map[string]*talk.Object{"thing": o}
	}})
	out := h.Input(":inspect thing")
	if calls != 1 || len(out) != 4 || out[3] != `read {name: "x", value: 3}` {
		t.Fatalf("%v calls=%d", out, calls)
	}
	recorded := WriteTranscript(items)
	parsed, err := ParseTranscript(recorded)
	if err != nil {
		t.Fatal(err)
	}
	_, replayed, err := ReplayTranscript(parsed, nil)
	if err != nil {
		t.Fatal(err)
	}
	if actual := WriteTranscript(replayed); actual != recorded {
		t.Fatalf("want\n%s\ngot\n%s", recorded, actual)
	}
	if !strings.Contains(recorded, `% {"crossing":1`) {
		t.Fatal(recorded)
	}
}

func TestMalformedObjectTranscript(t *testing.T) {
	var items []session.Item
	h := session.New(session.Environment{Now: func() time.Time { return time.Unix(0, 0) }, Record: func(i session.Item) { items = append(items, i) }, Objects: func(c *session.Objects) map[string]*talk.Object {
		k, err := c.DefineKind(talk.ObjectKindDef{Name: "Malformed", Props: []talk.Prop{{Name: "x", Get: func(*talk.Object) (talk.Value, error) { return talk.Int(1), nil }}}})
		if err != nil {
			t.Fatal(err)
		}
		o, err := c.Object(k, "o", nil)
		if err != nil {
			t.Fatal(err)
		}
		return map[string]*talk.Object{"object": o}
	}})
	h.Input(":inspect object")
	original := WriteTranscript(items)
	for _, changed := range []string{
		strings.Replace(original, `"crossing":1`, `"crossing":2`, 1),
		strings.Replace(original, `"reply":{"value":1}`, `"reply":{"value":{"$sessionFunction":"f99"}}`, 1),
		strings.Replace(original, `"operation":"get"`, `"operation":"set"`, 1),
		strings.Replace(original, `"reply":{"value":1}`, `"reply":{"value":{"1":1,"1":2}}`, 1),
		original + `% {"type":"object","object":{"kind":"Malformed","id":"o"}}` + "\n",
	} {
		parsed, err := ParseTranscript(changed)
		if err == nil {
			_, _, err = ReplayTranscript(parsed, nil)
		}
		if err == nil {
			t.Fatalf("accepted malformed Transcript\n%s", changed)
		}
	}
}

func TestCancelledInspectionNeedsNoReader(t *testing.T) {
	var items []session.Item
	var trace []string
	var c *session.Objects
	cancel := true
	h := session.New(session.Environment{Record: func(i session.Item) { items = append(items, i) }, Trace: func(l string) { trace = append(trace, l) }, Objects: func(ctx *session.Objects) map[string]*talk.Object {
		c = ctx
		k, e := c.DefineKind(talk.ObjectKindDef{Name: "Cancelled", Props: []talk.Prop{{Name: "x", Get: func(*talk.Object) (talk.Value, error) { t.Fatal("cancelled getter ran"); return talk.Nothing, nil }}}})
		if e != nil {
			t.Fatal(e)
		}
		o, e := c.Object(k, "o", nil)
		if e != nil {
			t.Fatal(e)
		}
		return map[string]*talk.Object{"object": o}
	}, Now: func() time.Time {
		if cancel {
			cancel = false
			c.Request(map[string]any{"kind": "cancel-delivery", "delivery": "d1"})
		}
		return time.Unix(0, 0)
	}})
	h.Input(":inspect object")
	requests := 0
	for _, l := range trace {
		if strings.HasPrefix(l, "> request ") {
			requests++
		}
	}
	if requests != 1 || strings.Contains(WriteTranscript(items), "property-begin") {
		t.Fatal(trace, WriteTranscript(items))
	}
	_, actual, e := ReplayTranscript(items, nil)
	if e != nil {
		t.Fatal(e)
	}
	if WriteTranscript(actual) != WriteTranscript(items) {
		t.Fatal(WriteTranscript(actual))
	}
}

func TestInspectionLimitAndHostPanicRoundTrip(t *testing.T) {
	for _, limit := range []bool{false, true} {
		var items []session.Item
		called := 0
		h := session.New(session.Environment{Now: func() time.Time { return time.Unix(0, 0) }, Record: func(i session.Item) { items = append(items, i) }, Objects: func(c *session.Objects) map[string]*talk.Object {
			cost := talk.Cost{}
			if limit {
				cost.Fuel = 1000
			}
			k, e := c.DefineKind(talk.ObjectKindDef{Name: "ReaderFailure", Props: []talk.Prop{{Name: "a", Get: func(*talk.Object) (talk.Value, error) { return talk.Int(1), nil }}, {Name: "z", GetCost: cost, Get: func(*talk.Object) (talk.Value, error) { called++; panic("Host secret") }}}})
			if e != nil {
				t.Fatal(e)
			}
			o, e := c.Object(k, "o", nil)
			if e != nil {
				t.Fatal(e)
			}
			return map[string]*talk.Object{"object": o}
		}})
		if limit {
			h.Input(":limits fuelPerRun 250")
		}
		out := h.Input(":inspect object")
		if !strings.Contains(strings.Join(out, "\n"), `read {name: "a", value: 1}`) {
			t.Fatal(out)
		}
		if limit && called != 0 || !limit && called != 1 {
			t.Fatal(called)
		}
		_, actual, e := ReplayTranscript(items, nil)
		if e != nil {
			t.Fatal(e)
		}
		if WriteTranscript(actual) != WriteTranscript(items) {
			t.Fatal(WriteTranscript(actual), WriteTranscript(items))
		}
	}
}
