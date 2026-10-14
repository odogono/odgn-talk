package messagelayer

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

func FuzzFrameJSON(f *testing.F) {
	for _, s := range []string{`{}`, `[]`, `null`, `true`, `1e99999`, `-0.25`, `{"a":[1,{},[true,"\\\"",null]],"a":2}`, `{"a":1,}`, `[1,]`, `[{]`, `"\uD800"`, `"\x00"`, `01`, `1 2`, `{"a":`, `"unterminated`} {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		if !utf8.Valid(data) {
			return
		}
		nodes, err := parseFrameJSON(data)
		if (err == nil) != json.Valid(data) {
			t.Fatalf("JSON syntax divergence for %q: %v", data, err)
		}
		if err == nil && !bytes.Equal(nodes[0].raw, bytes.TrimSpace(data)) {
			t.Fatalf("lost root span for %q", data)
		}
	})
}

func TestFrameDeclarationConversion(t *testing.T) {
	for _, s := range []string{
		`[{"name":"echo","mode":"immediate","args":["any"],"result":{"list":"number"},"cost":{"fuel":7},"errors":[],"scope":{"opens":"resource","abandon":"close"}}]`,
		`[{"name":"first","name":"last","description":null,"examples":["x"],"args":null,"scope":null,"cost":null}]`,
	} {
		var want, got []operationDecl
		if err := json.Unmarshal([]byte(s), &want); err != nil {
			t.Fatal(err)
		}
		if err := unmarshalFrame([]byte(s), &got); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %#v, want %#v", got, want)
		}
	}
	// Ignored declaration fields are still validated, without a nesting ceiling.
	deep := strings.Repeat("[", 100_000) + "1" + strings.Repeat("]", 100_000)
	var ops []operationDecl
	if err := unmarshalFrame([]byte(`[{"name":"echo","ignored":`+deep+`}]`), &ops); err != nil {
		t.Fatal(err)
	}
	if len(ops) != 1 || ops[0].Name != "echo" {
		t.Fatal(ops)
	}
}
