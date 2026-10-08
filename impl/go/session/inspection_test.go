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
