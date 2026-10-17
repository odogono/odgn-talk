package value

import "testing"

func TestWireMarksCoreRaisedErrorMessages(t *testing.T) {
	text := func(s string) Value { return Fields{Kind: Text, Text: s}.Value() }
	raised, err := NewMap([]Pair{{"code", text("x")}, {"message", text("m")}})
	if err != nil {
		t.Fatal(err)
	}
	raised.CoreMessage = true
	noFunctions := func(*FunctionData) (string, error) { return "", nil }
	wire, err := EncodeWire(raised, false, noFunctions)
	if err != nil || string(wire) != `{"$coreError":[["code","x"],["message","m"]]}` {
		t.Fatalf("wire %s, %v", wire, err)
	}
	// Storage has no mark.
	if stored, _ := Encode(raised, false); string(stored) != `{"code":"x","message":"m"}` {
		t.Fatalf("stored %s", stored)
	}
	back, err := DecodeWire(wire, nil, func(Value) (Value, error) { return Value{}, nil })
	if err != nil || !back.CoreMessage || back.Get("message").Text() != "m" {
		t.Fatalf("decoded %v, %v", back, err)
	}
	if _, err := Decode(wire, true, nil); err == nil {
		t.Fatal("storage decoded $coreError")
	}
	if _, err := DecodeWire([]byte(`{"$coreError":[["code","x"]]}`), nil, func(Value) (Value, error) { return Value{}, nil }); err == nil {
		t.Fatal("decoded $coreError without a message")
	}
}
