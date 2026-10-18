package value

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
)

func TestBinaryCanonicalVectors(t *testing.T) {
	for _, tc := range []struct{ text, wire string }{
		{"0", "0300"}, {"127", "037f"}, {"128", "038001"}, {"-1", "1001"},
		{"18446744073709551615", "03ffffffffffffffffff01"},
		{"-18446744073709551616", "1080808080808080808002"},
		{"1.25", "0404312e3235"}, {"0.0", "0403302e30"}, {"0.00", "0404302e3030"}, {"1.00", "0404312e3030"},
	} {
		n, err := decimal.Parse(tc.text)
		if err != nil {
			t.Fatal(err)
		}
		v := Fields{Kind: Number, Number: n}.Value()
		got, err := AppendBinary(nil, v, BinaryOptions{})
		if err != nil {
			t.Fatal(err)
		}
		want, _ := hex.DecodeString(tc.wire)
		if !bytes.Equal(got, want) {
			t.Fatalf("%s: %x want %x", tc.text, got, want)
		}
		back, err := DecodeBinary(want, nil, BinaryOptions{})
		if err != nil || back.Number().String() != tc.text {
			t.Fatalf("%s: %v %v", tc.text, back, err)
		}
	}
}

func TestBinaryValuesAndCoreError(t *testing.T) {
	text, _ := NewText("héllo")
	quantity, _ := NewQuantity(decimal.FromInt(2), "ms")
	instant, _ := NewInstant(-1, 999999)
	date, _ := ParseCivil("2026-10-18")
	pattern, err := ParsePattern("<digit>")
	if err != nil {
		t.Fatal(err)
	}
	rangeValue, _ := NewRange(Fields{Kind: Number, Number: decimal.FromInt(1)}.Value(), Fields{Kind: Number, Number: decimal.FromInt(3)}.Value())
	root := Fields{Kind: Map, CoreMessage: true, Entries: []Pair{{"message", text}, {"values", NewList([]Value{{}, {Kind: Boolean, Bool: true}, text, NewBytes([]byte{0, 255}), quantity, instant, date, pattern, rangeValue})}}}.Value()
	wire, err := AppendBinary(nil, root, BinaryOptions{CoreErrors: true})
	if err != nil {
		t.Fatal(err)
	}
	back, err := DecodeBinary(wire, nil, BinaryOptions{CoreErrors: true})
	if err != nil {
		t.Fatal(err)
	}
	again, err := AppendBinary(nil, back, BinaryOptions{CoreErrors: true})
	if err != nil || !bytes.Equal(wire, again) || !back.CoreMessage {
		t.Fatalf("%x %v", again, err)
	}
}

func TestBinaryRefusesNoncanonicalAndTruncatedItems(t *testing.T) {
	for _, wire := range [][]byte{
		{}, {3, 128, 0}, {16, 0}, {4, 1, '1'}, {5, 3, 'e', 0xcc, 0x81}, {5, 1, 255},
		{7, 2, 5, 1, 'a', 0, 5, 1, 'a', 0}, {0, 0}, {255}, {6, 255, 255, 255},
		{19, 3, 0, 0, 0}, {12, 3, 'b', 'a', 'd'}, {9, 3, 1, 5, 2, 'm', 's', 0},
	} {
		if _, err := DecodeBinary(wire, nil, BinaryOptions{}); err == nil {
			t.Fatalf("accepted %x", wire)
		}
	}
	v := NewList([]Value{NewBytes([]byte{1, 2, 3}), Fields{Kind: Number, Number: decimal.FromInt(500)}.Value()})
	wire, _ := AppendBinary(nil, v, BinaryOptions{})
	for i := range wire {
		if _, err := DecodeBinary(wire[:i], nil, BinaryOptions{}); err == nil {
			t.Fatalf("accepted truncation at %d", i)
		}
	}
}

func TestBinaryDeepValues(t *testing.T) {
	const depth = 20000
	wire := make([]byte, 0, depth*2+1)
	for range depth {
		wire = append(wire, 6, 1)
	}
	wire = append(wire, 0)
	v, err := DecodeBinary(wire, nil, BinaryOptions{})
	if err != nil {
		t.Fatal(err)
	}
	got, err := AppendBinary(nil, v, BinaryOptions{})
	if err != nil || !bytes.Equal(got, wire) {
		t.Fatal("deep round trip", err)
	}
}

func TestBinaryObjectResolution(t *testing.T) {
	object := Fields{Kind: Object, Object: &ObjectData{Kind: "thing", ID: "one"}}.Value()
	wire, _ := AppendBinary(nil, object, BinaryOptions{})
	if _, err := DecodeBinary(wire, nil, BinaryOptions{}); err == nil {
		t.Fatal("unresolved Object accepted")
	}
	v, err := DecodeBinary(wire, func(kind, id string) (Value, error) {
		if kind != "thing" || id != "one" {
			t.Fatal(kind, id)
		}
		return object, nil
	}, BinaryOptions{})
	if err != nil || v.Object() != object.Object() {
		t.Fatal("identity lost", err)
	}
}

func TestBinaryFunctionMetadata(t *testing.T) {
	text := func(s string) Value { v, _ := NewText(s); return v }
	fn := Fields{Kind: Function, Function: &FunctionData{Home: "s", Code: "token"}}.Value()
	payload := []Value{text("s"), text("given: 1"), text("token"), {}, Fields{Kind: Number, Number: decimal.FromInt(1)}.Value(), Fields{Kind: Number, Number: decimal.FromInt(2)}.Value(), NewBytes(make([]byte, 32))}
	options := BinaryOptions{FunctionMetadata: true,
		Encode: func(*FunctionData) ([]Value, error) { return payload, nil },
		Decode: func(xs []Value) (Value, error) {
			if len(xs) != 7 || xs[2].Text() != "token" {
				t.Fatal(xs)
			}
			return fn, nil
		},
	}
	wire, err := AppendBinary(nil, fn, options)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeBinary(wire, nil, BinaryOptions{Decode: options.Decode}); err == nil {
		t.Fatal("unnegotiated metadata accepted")
	}
	if wire[0] != 19 {
		t.Fatalf("metadata tag: %x", wire)
	}
	back, err := DecodeBinary(wire, nil, options)
	if err != nil || back.Function() != fn.Function() {
		t.Fatal("Function identity lost", err)
	}
	payload[5] = Fields{Kind: Number, Number: decimal.FromInt(0)}.Value()
	if _, err := AppendBinary(nil, fn, options); err == nil {
		t.Fatal("invalid arity metadata accepted")
	}
	if _, err := DecodeBinary([]byte{15, 0, 0, 0}, nil, options); err == nil {
		t.Fatal("invalid Function fields accepted")
	}
}

func TestBinaryCoreErrorRequiresMessageAndNegotiation(t *testing.T) {
	wire := []byte{17, 1, 5, 7, 'm', 'e', 's', 's', 'a', 'g', 'e', 5, 1, 'x'}
	if _, err := DecodeBinary(wire, nil, BinaryOptions{}); err == nil {
		t.Fatal("unnegotiated Core marker accepted")
	}
	if _, err := DecodeBinary(wire, nil, BinaryOptions{CoreErrors: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeBinary([]byte{17, 0}, nil, BinaryOptions{CoreErrors: true}); err == nil {
		t.Fatal("Core error without message accepted")
	}
}

func FuzzBinaryCanonicalRoundTrip(f *testing.F) {
	for _, seed := range [][]byte{{0}, {3, 128, 1}, {6, 2, 5, 1, 'x', 8, 2, 0, 255}, {4, 4, '0', '.', '0', '0'}, {7, 1, 5, 1, 'x', 0}} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, wire []byte) {
		options := BinaryOptions{CoreErrors: true}
		v, err := DecodeBinary(wire, nil, options)
		if err != nil {
			return
		}
		back, err := AppendBinary(nil, v, options)
		if err != nil || !bytes.Equal(wire, back) {
			t.Fatalf("noncanonical round trip %x -> %x: %v", wire, back, err)
		}
	})
}

// The same vectors run through the independent TS and Zig codecs.
func TestSharedBinaryVectors(t *testing.T) {
	data, err := os.ReadFile("../../../testdata/request-pump-binary.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		JSON string
		Hex  string
	}
	if err = json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, tc := range vectors {
		want, e := hex.DecodeString(tc.Hex)
		if e != nil {
			t.Fatal(e)
		}
		v, e := Decode([]byte(tc.JSON), true, nil)
		if e != nil {
			t.Fatalf("%s: %v", tc.JSON, e)
		}
		got, e := AppendBinary(nil, v, BinaryOptions{})
		if e != nil || !bytes.Equal(got, want) {
			t.Fatalf("%s: %x want %x: %v", tc.JSON, got, want, e)
		}
		back, e := DecodeBinary(want, nil, BinaryOptions{})
		if e != nil {
			t.Fatal(e)
		}
		gotJSON, e := Encode(back, false)
		if e != nil || string(gotJSON) != tc.JSON {
			t.Fatalf("%s: %s: %v", tc.JSON, gotJSON, e)
		}
	}
}
