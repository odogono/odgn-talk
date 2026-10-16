package northtalk

import (
	"errors"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
	"strings"
	"testing"
)

func TestValueEncodingRoundTrips(t *testing.T) {
	r, _ := Range(Int(3), Int(7))
	d, _ := ParseCivilDate("2026-09-27T14:30:00.5")
	i, _ := Instant(-1, 999999)
	m, _ := Map(KV("$ref", Int(1)), KV("é", List(Nothing, Bool(true))))
	for _, tt := range []struct {
		v    Value
		want string
	}{{Nothing, `null`}, {Bool(true), `true`}, {Int(3), `3`}, {dec(t, "3.0"), `{"$dec":"3.0"}`}, {dec(t, "9007199254740992"), `{"$dec":"9007199254740992"}`}, {text(t, "\"\\\n\t\x00<>\u2028"), `"\"\\\u000a\u0009\u0000<>` + "\u2028" + `"`}, {quantity(t, "2.50", "GBP"), `{"$quantity":["2.50","GBP"]}`}, {Bytes([]byte{13, 10}), `{"$bytes":"DQo="}`}, {r, `{"$range":[3,7]}`}, {d, `{"$date":"2026-09-27T14:30:00.5"}`}, {i, `{"$instant":"1969-12-31T23:59:59.999999Z"}`}, {m, `{"$map":[["$ref",1],["é",[null,true]]]}`}} {
		b, e := EncodeValue(tt.v)
		if e != nil || string(b) != tt.want {
			t.Fatalf("%s: got %s %v; want %s", tt.v, b, e, tt.want)
		}
		again, e := DecodeValue(b, nil)
		if e != nil || !again.Equal(tt.v) || again.String() != tt.v.String() {
			t.Fatalf("round trip %s: %s %v", tt.v, again, e)
		}
		reencoded, e := EncodeValue(again)
		if e != nil || string(reencoded) != string(b) {
			t.Fatalf("re-encoding %s: got %s %v", b, reencoded, e)
		}
	}
}

func TestDecodeValueRefusesNoncanonicalForms(t *testing.T) {
	for _, s := range []string{
		`{"$dec":"01"}`, `{"$dec":"3"}`, `{"$dec":"-9007199254740991"}`,
		`{"$dec":"0"}`, `{"$dec":"-0.0"}`, `{"$dec":" 3.0 "}`, `{"$dec":"0x20000000000000"}`,
		`1.0`, `-0`, `1e2`, `9007199254740992`, `-9007199254740992`,
		`{"$quantity":["3","days"]}`, `{"$quantity":["1","m/m"]}`,
		`{"$quantity":["01","kg"]}`,
		`{"$instant":"1970-01-01T01:00:00+01:00"}`,
		`{"$instant":"1970-01-01T00:00:00.500Z"}`,
		`{"$instant":"1970-01-01T00:00:00.0Z"}`,
		`{"$instant":"1970-01-01T00:00:00.1234567Z"}`, `{"$date":"2026-09-27T14:30:00.1234567"}`,
		`{"$date":"2026-09-27T00:00:00.0"}`,
		`{"$date":"2026-09-27T14:30:00.500"}`, `{"$date":" 2026-09-27 "}`,
		`{"$map":[["a",1]]}`, `{"$map":[]}`,
		`{"$pattern":"< \"a\" >"}`,
	} {
		t.Run(s, func(t *testing.T) {
			for _, input := range []string{s, `[{"nested":` + s + `}]`} {
				_, err := DecodeValue([]byte(input), nil)
				var hostErr *HostError
				if !errors.As(err, &hostErr) || hostErr.Code != InvalidValue {
					t.Errorf("DecodeValue(%s): want invalid value, got %v", input, err)
				}
			}
		})
	}
}

func TestDecodeValueCanonicalForms(t *testing.T) {
	for _, s := range []string{
		`0`, `9007199254740991`, `-9007199254740991`,
		`{"$dec":"9007199254740992"}`, `{"$dec":"-9007199254740992"}`,
		`{"$dec":"0.00"}`, `{"$dec":"3.0"}`, `{"$dec":"-2.50"}`,
		`{"$quantity":["3","day"]}`, `{"$quantity":["2.50","kg*m/s^2"]}`,
		`{"$instant":"1970-01-01T00:00:00Z"}`, `{"$instant":"1970-01-01T00:00:00.5Z"}`,
		`{"$date":"2026-09-27"}`, `{"$date":"2026-09-27T00:00:00"}`,
		`{"$date":"2026-09-27T14:30:00.5"}`, `{"$pattern":"<\"a\">"}`,
		`{"$bytes":"+/8="}`, `{"$range":[{"$dec":"1.0"},2]}`,
		`{}`, `{"a":1}`, `{"$map":[["a",1],["$ref",{"$dec":"3.0"}]]}`,
	} {
		t.Run(s, func(t *testing.T) {
			for _, input := range []string{s, `[{"nested":` + s + `}]`} {
				v, err := DecodeValue([]byte(input), nil)
				if err != nil {
					t.Fatal(err)
				}
				encoded, err := EncodeValue(v)
				if err != nil || string(encoded) != input {
					t.Fatalf("re-encoding %s: got %s %v", input, encoded, err)
				}
			}
		})
	}
}

func TestDecodeValueAllowsJSONSyntaxAndNFC(t *testing.T) {
	for _, tt := range []struct{ input, want string }{
		{` { "\u0024dec" : "3\u002e0" } `, `{"$dec":"3.0"}`},
		{` [ "e\u0301", "\/\n", { "e\u0301" : 1 } ] `, "[\"é\",\"/\\u000a\",{\"é\":1}]"},
		{` { "$pattern" : "<\"e\u0301\">" } `, `{"$pattern":"<\"é\">"}`},
	} {
		v, err := DecodeValue([]byte(tt.input), nil)
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := EncodeValue(v)
		if err != nil || string(encoded) != tt.want {
			t.Fatalf("re-encoding %s: got %s %v; want %s", tt.input, encoded, err, tt.want)
		}
	}
}
func TestDecodeRefusesMalformedInputs(t *testing.T) {
	for _, s := range []string{`"\ud800"`, `"\udc00"`, `"` + "\xff" + `"`, `[1,]`, `{"a":1,"a":2}`, `{"é":1,"e\u0301":2}`, `{"$unknown":1}`, `{"$bytes":"AB=="}`, `{"$bytes":"AQ"}`, `{"$bytes":"AQ==\n"}`, `{"$bytes":"-w=="}`, `{"$range":[1,true]}`, `{"$quantity":["1","m*ft"]}`, `{"$date":"2026-02-30"}`, `{"$instant":"2026-09-27"}`, `{"$object":["item","a"]}`, `{"$dec":"1e3"}`, `1e34`, `1 2`, `{"$dec":"1","extra":2}`} {
		if _, e := DecodeValue([]byte(s), nil); e == nil {
			t.Errorf("accepted %q", s)
		}
	}
	v, e := DecodeValue([]byte(`"\ud83d\udc67"`), nil)
	if e != nil || v.String() != `"👧"` {
		t.Fatal(v, e)
	}
}
func TestPlainJSON(t *testing.T) {
	v, e := DecodeJSON([]byte(`{"name":"Ann","scores":[2.50,null],"e":2.50e1}`))
	if e != nil {
		t.Fatal(e)
	}
	b, e := EncodeJSON(v)
	if e != nil || string(b) != `{"name":"Ann","scores":[2.50,null],"e":25.0}` {
		t.Fatal(string(b), e)
	}
	if b, e := EncodeJSON(text(t, "\n\t\r\b\f\x00")); e != nil || string(b) != `"\n\t\r\b\f\u0000"` {
		t.Fatal(string(b), e)
	}
	m, _ := Map(KV("total", List(Int(1), quantity(t, "5", "kg"))))
	_, e = EncodeJSON(m)
	var se *ScriptError
	if !errors.As(e, &se) || se.Code != "not encodable" || se.Data.Get("kind").String() != `"quantity"` || se.Data.Get("path").String() != `["total", 2]` {
		t.Fatal(e)
	}
}
func TestDeepEncodingHasNoReaderOnlyLimit(t *testing.T) {
	s := strings.Repeat("[", 2000) + `{"$dec":"2.50"}` + strings.Repeat("]", 2000)
	v, e := DecodeValue([]byte(s), nil)
	if e != nil {
		t.Fatal(e)
	}
	b, e := EncodeValue(v)
	if e != nil || string(b) != s {
		t.Fatal("deep round trip", e)
	}
}
func TestObjectResolution(t *testing.T) {
	o := &Object{kind: &ObjectKind{name: "item"}, id: "a\"\n"}
	b, e := EncodeValue(o.Value())
	if e != nil {
		t.Fatal(e)
	}
	v, e := DecodeValue(b, func(kind, id string) (*Object, bool) { return o, kind == "item" && id == o.id })
	if e != nil || !v.Equal(o.Value()) {
		t.Fatal(v, e)
	}
	if _, e := DecodeValue(b, func(kind, id string) (*Object, bool) { return &Object{kind: &ObjectKind{name: "wrong"}, id: id}, true }); e == nil {
		t.Fatal("resolver returned wrong object")
	}
}

func TestPatternAndFunctionMetadataAtTheHost(t *testing.T) {
	v, e := DecodeValue([]byte(`{"$pattern":"<\"a & b\">"}`), nil)
	if e != nil {
		t.Fatal(e)
	}
	if source, ok := v.PatternSource(); !ok || source != `<"a & b">` {
		t.Fatal(source, ok)
	}
	b, e := EncodeValue(v)
	if e != nil || string(b) != `{"$pattern":"<\"a & b\">"}` {
		t.Fatal(string(b), e)
	}
	f, e := corevalue.ParseDisplay(`<function weather:12:3 {n: 3}>`, nil)
	if e != nil {
		t.Fatal(e)
	}
	function := Value{inner: f}
	if home, ok := function.HomeScript(); !ok || home != "weather" {
		t.Fatal(home, ok)
	}
	if function.String() != `<function weather:12:3 {n: 3}>` || !function.Equal(function) {
		t.Fatal(function)
	}
	if _, e := EncodeValue(List(Int(1), function)); e == nil {
		t.Fatal("nested function encoded")
	}
}
