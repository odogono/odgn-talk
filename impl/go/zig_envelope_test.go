//go:build talk_zig_experimental

package northtalk

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

type envelopeVector struct {
	Name, Direction, Hex, Tree string
	Tag                        byte
}

func envelopeVectors(t *testing.T) []envelopeVector {
	t.Helper()
	data, err := os.ReadFile("../testdata/envelope-frames.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []envelopeVector
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	return vectors
}

// The adapter only writes inputs and reads replies. Check both directions
// through its framing primitives, decoding each field against the independent
// tree before re-encoding it. In particular, no span is copied to the output.
func TestZigBackendSharedEnvelopeVectors(t *testing.T) {
	for _, vector := range envelopeVectors(t) {
		t.Run(vector.Name, func(t *testing.T) {
			data, err := hex.DecodeString(vector.Hex)
			if err != nil {
				t.Fatal(err)
			}
			schema := zbEnvelopes[vector.Tag]
			if schema.direction != vector.Direction {
				t.Fatal("direction", schema.direction)
			}
			tree, err := zigParseReply([]byte(vector.Tree))
			if err != nil {
				t.Fatal(err)
			}
			if method := tree.get("m"); len(method) != 0 {
				if zigText(method) != schema.name {
					t.Fatal("message name", zigText(method), schema.name)
				}
			} else if need := tree.get("need"); len(need) != 0 && zigText(need.get("m")) != schema.name {
				t.Fatal("need name", zigText(need.get("m")), schema.name)
			}
			flat := envelopeFlat(tree)
			var get func(string) zigReply = flat.get
			if vector.Tag == zbOpResult || vector.Tag == zbPropResult {
				for _, key := range []string{"result", "value", "started", "done", "fail", "limit", "hostError", "ok"} {
					if outcome := flat.get(key); len(outcome) != 0 {
						base := get
						get = func(k string) zigReply {
							switch k {
							case "outcome":
								b, _ := json.Marshal(key)
								return b
							case "value":
								if key == "fail" {
									return outcome.get("data")
								}
								if key == "result" || key == "value" {
									return outcome
								}
								return nil
							case "code", "message":
								return outcome.get(k)
							default:
								return base(k)
							}
						}
						break
					}
				}
			} else if vector.Tag == zbPropNeed {
				base := get
				get = func(k string) zigReply {
					switch k {
					case "object":
						return base(k).get("$object")
					case "set":
						if len(base("value")) != 0 {
							return zigReply("true")
						}
						return zigReply("false")
					default:
						return base(k)
					}
				}
			}
			r := zbReader{d: data, at: len(zbPrefix) + 2}
			view, err := r.positional(&schema)
			if err != nil || r.at != len(data) {
				t.Fatal("record", err, r.at, len(data))
			}
			w := &zbWriter{buf: append(append([]byte{}, zbPrefix...), zbFields, vector.Tag)}
			w.begin(schema.fields, true)
			for _, f := range schema.items {
				w.key(f.Name)
				envelopeItem(t, w, view.get(f.Name), get(f.Name), f.Kind, f.Name, "")
			}
			w.end()
			if !bytes.Equal(w.buf, data) {
				t.Fatalf("re-encode\n%x\n%x", w.buf, data)
			}
		})
	}
}

// Merge the JSON envelope's nested need/ok, retaining raw ordered JSON for
// every nested record and for the Value Encoding's observable Map order.
func envelopeFlat(tree zigReply) zigReply {
	var pairs [][]byte
	add := func(e zigMember) {
		key, _ := json.Marshal(e.Key)
		pairs = append(pairs, append(append(key, ':'), e.Val...))
	}
	for _, e := range tree.entries() {
		if e.Key == "need" || e.Key == "ok" && len(tree.get("m")) == 0 {
			for _, inner := range e.Val.entries() {
				add(inner)
			}
		} else {
			add(e)
		}
	}
	return append(append([]byte{'{'}, bytes.Join(pairs, []byte{','})...), '}')
}

func envelopeItem(t *testing.T, w *zbWriter, span []byte, expected zigReply, kind, key, parent string) {
	t.Helper()
	if !expected.present() {
		if span != nil && !zbNothing(span) {
			t.Fatalf("%s: expected Nothing, got %x", key, span)
		}
		w.buf = append(w.buf, 0)
		return
	}
	if span == nil {
		t.Fatalf("%s: missing %s", key, expected)
	}
	if kind == "value" {
		resolve := func(k, id string) (corevalue.Value, error) {
			return corevalue.Fields{Kind: corevalue.Object, Object: &corevalue.ObjectData{Kind: k, ID: id}}.Value(), nil
		}
		function := func(parts []corevalue.Value) (corevalue.Value, error) {
			return corevalue.Fields{Kind: corevalue.Function, Function: &corevalue.FunctionData{Home: parts[0].Text(), Code: parts[2].Text(), CodeState: parts}}.Value(), nil
		}
		opts := corevalue.BinaryOptions{Decode: function, Encode: func(f *corevalue.FunctionData) ([]corevalue.Value, error) {
			return f.CodeState.([]corevalue.Value), nil
		}}
		want, err := corevalue.DecodeWire(expected, resolve, func(v corevalue.Value) (corevalue.Value, error) { return function(v.Items()) })
		if err != nil {
			t.Fatal(key, err)
		}
		decoded, err := corevalue.DecodeBinary(span, resolve, opts)
		if err != nil {
			t.Fatal(key, err)
		}
		a, err := corevalue.AppendBinary(nil, want, opts)
		if err != nil {
			t.Fatal(key, err)
		}
		b, err := corevalue.AppendBinary(nil, decoded, opts)
		if err != nil || !bytes.Equal(a, b) {
			t.Fatalf("%s: Value differs: %x %x %v", key, a, b, err)
		}
		w.buf = append(w.buf, b...)
		return
	}
	if kind == "reports" || kind == "settlements" {
		r := zbReader{d: span}
		tag, err := r.byte()
		if err != nil || tag != 6 {
			t.Fatal("list", err)
		}
		count, err := r.uvarint()
		xs := expected.items()
		if err != nil || int(count) != len(xs) {
			t.Fatal("list count", err)
		}
		w.list(len(xs))
		for _, x := range xs {
			var schema zbSchema
			if kind == "reports" {
				tag, err := r.byte()
				if err != nil {
					t.Fatal(err)
				}
				schema = zbReportSchemas[tag]
				if schema.name != zigText(x.get("kind")) {
					t.Fatal("Report kind", schema.name)
				}
				w.buf = append(w.buf, tag)
			} else {
				schema = zbSchema{fields: zbSettlement, items: generated.EnvelopeSettlement, reports: -1}
			}
			view, err := r.positional(&schema)
			if err != nil {
				t.Fatal(err)
			}
			w.begin(schema.fields, true)
			for _, f := range schema.items {
				w.key(f.Name)
				envelopeItem(t, w, view.get(f.Name), x.get(f.Name), f.Kind, f.Name, "")
			}
			w.end()
		}
		if r.at != len(span) {
			t.Fatal("trailing list bytes")
		}
		return
	}
	if kind == "instant" {
		got, ok := zbInstant(span)
		want, err := time.Parse(time.RFC3339Nano, zigText(expected))
		if !ok || err != nil || !got.Equal(want) {
			t.Fatal(key, "instant", err)
		}
		w.instant(got)
		return
	}
	if expected.isMap() {
		view, err := zbMapView(span)
		if err != nil {
			t.Fatal(key, err)
		}
		entries := expected.entries()
		if len(view.keys) != len(entries) {
			t.Fatal(key, "map count")
		}
		w.begin(nil, false)
		for _, e := range entries {
			name := e.Key
			w.key(name)
			nested := "record"
			if name == "args" {
				nested = "values"
			} else if name == "object" || name == "fn" || name == "result" || name == "error" || name == "target" || name == "reason" && (key == "vetoes" || parent == "vetoes") {
				nested = "value"
			}
			envelopeItem(t, w, view.get(name), e.Val, nested, name, key)
		}
		w.end()
		return
	}
	if expected.isList() {
		xs, err := zbItems(span)
		es := expected.items()
		if err != nil || len(xs) != len(es) {
			t.Fatal(key, "list", err)
		}
		w.list(len(xs))
		nested := "record"
		if kind == "values" {
			nested = "value"
		}
		for i, x := range xs {
			envelopeItem(t, w, x, es[i], nested, "", key)
		}
		return
	}
	if text, ok := expected.text(); ok {
		got, ok := zbText(span)
		if !ok || got != text {
			t.Fatalf("%s: text %q != %q", key, got, text)
		}
		w.ptext(got)
		return
	}
	if b, ok := expected.boolean(); ok {
		if len(span) != 1 || span[0] != map[bool]byte{false: 1, true: 2}[b] {
			t.Fatal(key, "bool")
		}
		w.buf = append(w.buf, span[0])
		return
	}
	if kind == "uint" {
		want, err := strconv.ParseUint(string(expected), 10, 64)
		var got uint64
		var n int
		if len(span) > 0 && span[0] == 3 {
			got, n = binary.Uvarint(span[1:])
		}
		if err != nil || n <= 0 || n+1 != len(span) || got != want {
			t.Fatal(key, "uint", got, want, err)
		}
		w.buf = binary.AppendUvarint(append(w.buf, 3), got)
		return
	}
	want, ok := expected.int64()
	got, valid := zbInt(span)
	if !ok || !valid || want != got {
		t.Fatal(key, "integer", want, got)
	}
	w.int(got)
}
