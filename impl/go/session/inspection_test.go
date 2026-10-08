package session

import (
	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestInspectionExpressionDiagnostics(t *testing.T) {
	var trace []string
	h := New(Environment{Now: func() time.Time { return time.Unix(0, 0) }, Trace: func(l string) { trace = append(trace, l) }})
	h.Input("script variable calls = 0")
	h.Input("function once\nadd 1 to calls\nreturn 1\nend once")
	source := h.Source()
	before := append([]string(nil), trace...)
	for _, test := range []struct {
		input, diagnostic string
	}{
		{":inspect given x => x", "! unexpected token at 1:9"},
		{":inspect [\n  1,\n  )]", "! unexpected token at 3:3"},
		{":inspect once() + )", "! unexpected token at 1:10"},
		{":inspect 1 + @", "! bad character at 1:5"},
		{":inspect \"unfinished", "! unterminated text at 1:1"},
		{":inspect 1 +", "! unexpected token at 1:4"},
		{":inspect put once() into calls", "! bad arguments"},
		{":inspect constant wrong = once()", "! bad arguments"},
		{":inspect once() 2", "! bad arguments"},
		{":inspect once()\n2", "! bad arguments"},
		{":inspect once() -- trailing comment\n\n2", "! bad arguments"},
	} {
		if out := h.Input(test.input); !reflect.DeepEqual(out, []string{test.diagnostic}) {
			t.Errorf("%q: got %v, want %s", test.input, out, test.diagnostic)
		}
	}
	if h.Source() != source || !reflect.DeepEqual(trace, before) {
		t.Fatal("refused inspection changed source or executed", h.Source(), trace)
	}
	if out := h.Input("calls"); !reflect.DeepEqual(out, []string{"0"}) {
		t.Fatal(out)
	}
}

func TestInspectionAnonymousLambda(t *testing.T) {
	h := New(Environment{Now: func() time.Time { return time.Unix(0, 0) }})
	want := []string{
		`value {kind: "function", value: <function session+1:2:8>}`,
		`function {name: nothing, arity: 1..1, home: "session"}`,
		`doc ""`,
	}
	if out := h.Input(":inspect given x: x"); !reflect.DeepEqual(out, want) {
		t.Fatal(out)
	}
}

func TestPassiveInspectionAndReaderHygiene(t *testing.T) {
	var trace []string
	h := New(Environment{Now: func() time.Time { return time.Unix(0, 0) }, Trace: func(l string) { trace = append(trace, l) }, Objects: func(c *Objects) map[string]*talk.Object {
		k, e := c.DefineKind(talk.ObjectKindDef{Name: "Hygiene", Props: []talk.Prop{{Name: "x", Get: func(*talk.Object) (talk.Value, error) { return talk.Int(1), nil }}}})
		if e != nil {
			t.Fatal(e)
		}
		o, e := c.Object(k, "o", nil)
		if e != nil {
			t.Fatal(e)
		}
		return map[string]*talk.Object{"object": o}
	}})
	h.Input("constant entry2Object = 99")
	h.Input("on entry3Row\nend entry3Row")
	before := h.Source()
	h.Input(":inspect object")
	if h.Source() != before {
		t.Fatal("reader entered Session Source", h.Source())
	}
	found := false
	for _, l := range trace {
		if strings.HasPrefix(l, "> request ") && strings.Contains(l, "message=entry4:to:") {
			found = true
		}
	}
	if !found {
		t.Fatal(trace)
	}
	for _, source := range []string{":inspect put 1 into x", ":inspect constant wrong = 1", ":inspect 1\n2"} {
		if out := h.Input(source); !reflect.DeepEqual(out, []string{"! bad arguments"}) {
			t.Fatal(source, out)
		}
	}
	if !h.NeedsMore(":inspect [\n1,") {
		t.Fatal("multiline inspection ended early")
	}
	for _, test := range []struct {
		source string
		want   []string
	}{
		{":inspect {z: [1], a: \"é\"}", []string{`value {kind: "map", value: {z: [1], a: "é"}}`, `size 2`, `field "a" = "é"`, `field "z" = [1]`}},
		{":inspect <<0x01, 0x02>>", []string{`value {kind: "bytes", value: <<0x01, 0x02>>}`, `size 2`}},
		{":inspect \"👨‍👩‍👧‍👦é\"", []string{`value {kind: "text", value: "👨‍👩‍👧‍👦é"}`, `size 2`}},
	} {
		if out := h.Input(test.source); !reflect.DeepEqual(out, test.want) {
			t.Fatal(test.source, out)
		}
	}
	b, e := os.ReadFile("../../../spec/session/inspect-reader.talk")
	if e != nil {
		t.Fatal(e)
	}
	if string(b) != generated.InspectReader {
		t.Fatal("reader source differs from normative template")
	}
}
