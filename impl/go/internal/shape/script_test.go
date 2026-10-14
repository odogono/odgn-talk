package shape

import (
	"strings"
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

func txt(s string) value.Value { v, _ := value.NewText(s); return v }
func num(n int64) value.Value {
	return value.Fields{Kind: value.Number, Number: decimal.FromInt(n)}.Value()
}
func listOf(vs ...value.Value) value.Value    { return value.NewList(vs) }
func mapOf(pairs ...value.Pair) value.Value   { v, _ := value.NewMap(pairs); return v }
func pair(k string, v value.Value) value.Pair { return value.Pair{Key: k, Val: v} }

func displayPath(path []value.Value) string {
	parts := make([]string, len(path))
	for i, p := range path {
		parts[i] = p.Display()
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

func TestDecodeDefinitionErrors(t *testing.T) {
	for _, tc := range []struct {
		data   value.Value
		reason string
		path   string
	}{
		{num(42), "not a shape", "[]"},
		{txt("bogus"), "unknown kind", "[]"},
		{mapOf(pair("list", txt("number")), pair("optional", txt("text"))), "ambiguous shape", "[]"},
		{mapOf(pair("quantity", txt("furlongs"))), "invalid unit", `["quantity"]`},
		{mapOf(pair("unitKind", txt("weightiness"))), "unknown unit kind", `["unitKind"]`},
		{mapOf(pair("object", num(1))), "invalid object kind", `["object"]`},
		{mapOf(pair("oneOf", txt("number"))), "invalid alternatives", `["oneOf"]`},
		{mapOf(pair("oneOf", listOf())), "empty union", `["oneOf"]`},
		{mapOf(pair("oneOf", listOf(txt("number"), txt("bogus")))), "unknown kind", `["oneOf", 2]`},
		{mapOf(pair("map", txt("x"))), "invalid fields", `["map"]`},
		{mapOf(pair("map", listOf(txt("x")))), "invalid field", `["map", 1]`},
		{mapOf(pair("map", listOf(mapOf(pair("shape", txt("number")))))), "invalid field key", `["map", 1]`},
		{mapOf(pair("map", listOf(mapOf(pair("key", txt("a")))))), "missing field shape", `["map", 1]`},
		{mapOf(pair("map", listOf(mapOf(pair("key", txt("a")), pair("shape", txt("number")), pair("optional", txt("yes")))))), "invalid flag", `["map", 1, "optional"]`},
		{mapOf(pair("map", listOf(
			mapOf(pair("key", txt("a")), pair("shape", txt("number"))),
			mapOf(pair("key", txt("a")), pair("shape", txt("text"))),
		))), "duplicate field", `["map", 2, "key"]`},
		{mapOf(pair("map", listOf()), pair("open", txt("yes"))), "invalid flag", `["open"]`},
	} {
		_, err, scanned := Decode(tc.data)
		if err == nil {
			t.Fatalf("%s: decoded, want %s", tc.data.Display(), tc.reason)
		}
		if err.Reason != tc.reason || displayPath(err.Path) != tc.path {
			t.Errorf("%s: got %s at %s, want %s at %s", tc.data.Display(), err.Reason, displayPath(err.Path), tc.reason, tc.path)
		}
		if scanned == 0 {
			t.Errorf("%s: failed validation charged nothing", tc.data.Display())
		}
	}
}

func decode(t *testing.T, data value.Value) (Shape, int64) {
	t.Helper()
	s, err, scanned := Decode(data)
	if err != nil {
		t.Fatalf("Decode(%s): %s", data.Display(), err.Reason)
	}
	return s, scanned
}

func TestDiagnosticsFirstAndAll(t *testing.T) {
	s, scanned := decode(t, mapOf(pair("list", txt("number"))))
	v := listOf(num(1), txt("x"), value.Value{Kind: value.Boolean, Bool: true})
	first, _ := Diagnostics(v, s, true, scanned)
	if len(first) != 1 || first[0].Expected != "number" || displayPath(first[0].Path) != "[2]" {
		t.Fatalf("first: %+v", first)
	}
	all, _ := Diagnostics(v, s, false, scanned)
	if len(all) != 2 || displayPath(all[1].Path) != "[3]" {
		t.Fatalf("all: %+v", all)
	}
	// A successful value gives no diagnostics in either mode.
	ok, _ := Diagnostics(listOf(num(1)), s, false, scanned)
	if len(ok) != 0 {
		t.Fatalf("ok: %+v", ok)
	}
}

func TestUnionAlternativesGrouped(t *testing.T) {
	s, scanned := decode(t, mapOf(pair("oneOf", listOf(txt("text"), mapOf(pair("list", txt("number")))))))
	all, _ := Diagnostics(value.Value{Kind: value.Boolean, Bool: true}, s, false, scanned)
	if len(all) != 1 || len(all[0].Alternatives) != 2 {
		t.Fatalf("%+v", all)
	}
	if all[0].Expected != "text or list" || all[0].Alternatives[1][0].Expected != "list" {
		t.Fatalf("%+v", all[0])
	}
	record := Record(all[0])
	if record.Get("code").Text() != "wrong kind" || record.Get("alternatives").Kind != value.List {
		t.Fatalf("record: %s", record.Display())
	}
	if _, has := lookup(record.Entries(), "message"); has {
		t.Fatalf("record carries message: %s", record.Display())
	}
}

func TestOptionalSuffixInFirstMode(t *testing.T) {
	s, scanned := decode(t, mapOf(pair("optional", txt("text"))))
	first, _ := Diagnostics(num(3), s, true, scanned)
	if len(first) != 1 || first[0].Expected != "text or nothing" {
		t.Fatalf("%+v", first)
	}
}

func TestDeepNestingIsStackSafe(t *testing.T) {
	data := txt("number")
	v := num(1)
	for i := 0; i < 5000; i++ {
		data = mapOf(pair("list", data))
		v = listOf(v)
	}
	s, scanned := decode(t, data)
	all, _ := Diagnostics(v, s, false, scanned)
	if len(all) != 0 {
		t.Fatalf("%+v", all[0])
	}
}
