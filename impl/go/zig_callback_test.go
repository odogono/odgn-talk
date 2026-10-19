//go:build talk_zig_experimental

package northtalk

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func TestZigBackendCallbackEnvelope(t *testing.T) {
	core := New()
	calls := 0
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	def, err := core.DefineCapability("CallbackHost", Operation{
		Name: "echo", Mode: Immediate, Args: []Shape{NumberShape}, Result: NumberShape,
		Do: func(c *Call, args []Value) (Value, error) {
			calls++
			if c.ScriptName() != "s" || c.GrantName() != "api" || c.Binding() != "binding" || c.RunID() != "s/r1" || c.ID() != "s/r1.c1" || c.SegmentID() != "s/r1.s1" || c.ScopeName() != "scope" || c.Automatic() || !c.Now().Equal(now) || len(args) != 1 || !args[0].Equal(Int(41)) {
				t.Fatalf("callback context: %+v; args: %v", c, args)
			}
			return args[0], c.Charge(2)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	g := core.NewGroup(GroupOptions{})
	if _, err := g.Load(LoadOptions{Name: "s", Source: "on go\n ask api to echo 41\n return it\nend go", Grants: map[string]*Grant{"api": def.GrantAll("binding")}}); err != nil {
		t.Fatal(err)
	}
	b := g.backend.(*zigGroup)
	// Exercise the actual callback with reordered and escaped keys, duplicate
	// members and an unknown nested value. The first matching member wins.
	frame := fmt.Sprintf(`{"unknown":{"script":"wrong"},"args":[41],"fuelLeft":4,"fuelLeft":"wrong","segment":"s/r1.s1","run":"s/r1","scope":"scope","automatic":null,"automatic":true,"call":"s/r1.c1","capability":%q,"operation":"echo","grant":"api","now":"2026-10-18T12:00:00Z","\u0073cript":"s","script":"wrong","m":"op"}`, b.reg.handle(def))
	need, err := zigParseReply([]byte(frame))
	if err != nil {
		t.Fatal(err)
	}
	out, err := b.callback(need)
	raw, ok := out["result"].(json.RawMessage)
	if err != nil || calls != 1 || out["charged"] != int64(2) || !ok || string(raw) != "41" {
		t.Fatalf("callback reply: %v, %v; calls: %d", out, err, calls)
	}
	// A malformed Fuel field must still be refused before invoking the Host.
	bad, err := zigParseReply([]byte(fmt.Sprintf(`{"m":"op","script":"s","grant":"api","operation":"echo","capability":%q,"args":[41],"now":"2026-10-18T12:00:00Z","fuelLeft":"wrong"}`, b.reg.handle(def))))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.callback(bad); err == nil || calls != 1 {
		t.Fatalf("malformed Fuel: %v; calls: %d", err, calls)
	}
}

func TestZigBackendPropertyEnvelopePreservesNullSetter(t *testing.T) {
	core := New()
	gets, sets := 0, 0
	kind, err := core.DefineObjectKind(ObjectKindDef{Name: "CallbackMeter", Props: []Prop{{
		Name: "value", Shape: AnyShape,
		Get: func(*Object) (Value, error) { gets++; return Int(7), nil },
		Set: func(_ *Object, v Value) error {
			sets++
			if !v.Equal(Nothing) {
				t.Fatalf("setter received %v", v)
			}
			return nil
		},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	g := core.NewGroup(GroupOptions{})
	if _, err := g.Object(kind, "meter", nil); err != nil {
		t.Fatal(err)
	}
	b := g.backend.(*zigGroup)
	for _, frame := range []string{
		`{"m":"prop","value":null,"value":123,"prop":"value","object":{"$object":["CallbackMeter","meter"]}}`,
		`{"m":"prop","unknown":{"value":123},"\u0070rop":"value","object":{"$object":["CallbackMeter","meter"]}}`,
	} {
		need, err := zigParseReply([]byte(frame))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := b.callback(need); err != nil {
			t.Fatal(err)
		}
	}
	if gets != 1 || sets != 1 {
		t.Fatalf("gets: %d; sets: %d", gets, sets)
	}
}

// A binary prop need marks a setter with `set`, since its Nothing value is
// an absent positional field (#1311).
func TestZigBackendBinaryPropertyNeedMarksSetter(t *testing.T) {
	core := New()
	gets, sets := 0, 0
	kind, err := core.DefineObjectKind(ObjectKindDef{Name: "BinaryMeter", Props: []Prop{{
		Name: "value", Shape: AnyShape,
		Get: func(*Object) (Value, error) { gets++; return Int(7), nil },
		Set: func(_ *Object, v Value) error {
			sets++
			if !v.Equal(Nothing) {
				t.Fatalf("setter received %v", v)
			}
			return nil
		},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	g := core.NewGroup(GroupOptions{})
	if _, err := g.Object(kind, "meter", nil); err != nil {
		t.Fatal(err)
	}
	b := g.backend.(*zigGroup)
	need := func(set bool) []byte {
		w := &zbWriter{}
		w.buf = append(append(w.buf, zbPrefix...), byte(zbFields), zbPropNeed)
		w.begin(zbCallbacks[zbPropNeed].fields, true)
		w.key("ref")
		w.int(9)
		w.key("object")
		w.list(2)
		w.ptext("BinaryMeter")
		w.ptext("meter")
		w.key("prop")
		w.ptext("value")
		if set {
			w.key("set")
			w.buf = append(w.buf, 0x02)
		}
		w.end()
		return w.buf
	}
	for _, set := range []bool{true, false} {
		p, err := zbParse(need(set))
		if err != nil || p.need == nil || p.ref != 9 {
			t.Fatal(p, err)
		}
		frame, err := b.callbackBinary(p.need)
		if err != nil {
			t.Fatal(err)
		}
		r := zbReader{d: frame.bytes(9)[len(zbPrefix)+2:]}
		view, err := r.positional(zbCallbacks[zbPropResult].fields)
		if err != nil {
			t.Fatal(err)
		}
		outcome, _ := zbText(view.get("outcome"))
		if want := map[bool]string{true: "ok", false: "value"}[set]; outcome != want {
			t.Fatalf("outcome %q, want %q", outcome, want)
		}
	}
	if gets != 1 || sets != 1 {
		t.Fatalf("gets: %d; sets: %d", gets, sets)
	}
}
