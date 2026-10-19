//go:build talk_zig_experimental

package northtalk

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// The request path decodes several Reports per Pump, including their embedded
// ancestry. Keep the whole Report here so member staging shows up in benchmem.
func BenchmarkZigReplyReport(b *testing.B) {
	row, err := zigParseReply([]byte(`{"kind":"run started","script":"s","run":"s.r1","delivery":"d1","rootDelivery":"d1","parentRun":"","parentCall":"","selector":"ping","fn":null,"args":[41]}`))
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	for b.Loop() {
		var report RunStarted
		if err := zigDecode(row, reflect.ValueOf(&report).Elem()); err != nil {
			b.Fatal(err)
		}
		if report.RootDelivery != "d1" || len(report.Args) != 1 {
			b.Fatal(report)
		}
	}
}

func TestZigBackendReplyDecodesStructFields(t *testing.T) {
	// Escaped keys, unknown nested members, embedded fields and nulls must keep
	// their lookup semantics. The first matching member wins, even if null.
	frame := strings.ReplaceAll(`{"unknown":{"script":"wrong"},"scr%u0069pt":"s","script":"later","rootDelivery":"d1","parentRun":null,"parentRun":"later","run":"s.r1","fn":null,"args":[41],"selector":"ping"}`, "%u", "\\"+"u")
	row, err := zigParseReply([]byte(frame))
	if err != nil {
		t.Fatal(err)
	}
	var report RunStarted
	if err := zigDecode(row, reflect.ValueOf(&report).Elem()); err != nil {
		t.Fatal(err)
	}
	if report.Script != "s" || report.Run != "s.r1" || report.RootDelivery != "d1" || report.ParentRun != "" || report.Function != nil || len(report.Args) != 1 || !report.Args[0].Equal(Int(41)) || report.Selector != "ping" {
		t.Fatalf("decoded Report: %+v", report)
	}
}

func TestZigBackendReplyRefusesMalformedFrames(t *testing.T) {
	for _, frame := range []string{``, `{`, `{"a"}`, `{"a":1,}`, `[1 2]`, `{"a":01}`, `{"a":1.}`, `"\x"`, "\"\x01\"", `{"a":tru}`, `{} {}`, "\"\xff\"", `{"a":"\u12"}`} {
		if _, err := zigParseReply([]byte(frame)); err == nil {
			t.Errorf("accepted %q", frame)
		}
	}
}

func TestZigBackendReplyReadsEnvelopeInPlace(t *testing.T) {
	// %u stands for a JSON \u escape: "%u00e9" is é, "k%u0065y" is key.
	frame := strings.ReplaceAll(` {"ref":7, "ok":{"n":-12,"t":"a\"b%u00e9","b":true,"l":[1,{"x":[]},"]"],"z":null}, "k%u0065y":"v"} `, "%u", "\\"+"u")
	root, err := zigParseReply([]byte(frame))
	if err != nil {
		t.Fatal(err)
	}
	packet := zigReadPacket(root)
	if n, ok := packet.ref.int64(); !ok || n != 7 {
		t.Fatalf("ref %q", packet.ref)
	}
	ok := packet.ok
	if n, _ := ok.get("n").int64(); n != -12 {
		t.Errorf("n %q", ok.get("n"))
	}
	if s := zigText(ok.get("t")); s != `a"bé` {
		t.Errorf("t %q", s)
	}
	if b, _ := ok.get("b").boolean(); !b {
		t.Errorf("b %q", ok.get("b"))
	}
	items := ok.get("l").items()
	if len(items) != 3 || string(items[1]) != `{"x":[]}` || zigText(items[2]) != "]" {
		t.Errorf("l %q", items)
	}
	if ok.get("z").present() || ok.get("missing").present() || packet.err.present() {
		t.Error("null or absent member is present")
	}
	if zigText(root.get("key")) != "v" {
		t.Error("escaped key not found")
	}
}

// ADR 0088: a deep payload is validated and skipped without recursion, and
// left for the Value Encoding reader.
func TestZigBackendReplyToleratesDeepPayloads(t *testing.T) {
	const depth = 100_000
	deep := strings.Repeat("[", depth) + strings.Repeat("]", depth)
	root, err := zigParseReply([]byte(`{"ok":{"value":` + deep + `,"after":1},"ref":1}`))
	if err != nil {
		t.Fatal(err)
	}
	packet := zigReadPacket(root)
	if len(packet.ok.get("value")) != 2*depth {
		t.Fatal("deep payload span")
	}
	if n, _ := packet.ok.get("after").int64(); n != 1 {
		t.Fatal("member after a deep payload")
	}
	if n, _ := packet.ref.int64(); n != 1 {
		t.Fatal("ref after a deep payload")
	}
}

// These tests exercise the reader without New, zigEngine or talk.wasm. The
// fixture holds independently written frames rather than the adapter's writer
// output. #1332 will supply shared fields vectors once its Go step lands.
type zigReplyFixture struct {
	Name, Sent, JSON, Fields, Map string
}

func zigReplyFixtures(t *testing.T) []zigReplyFixture {
	t.Helper()
	data, err := os.ReadFile("testdata/zig-reply-frames.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []zigReplyFixture
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	return cases
}

// A small table fake gives both envelopes the very same Host identities.
type zigReplyResolver struct {
	objects   map[objectKey]*Object
	functions map[string]corevalue.Value
}

func (r zigReplyResolver) resolve(kind, id string) (*Object, bool) {
	o, ok := r.objects[objectKey{kind, id}]
	return o, ok
}
func (r zigReplyResolver) zigFunction(parts []corevalue.Value) (corevalue.Value, error) {
	if len(parts) == 3 {
		if v, ok := r.functions[parts[2].Text()]; ok {
			return v, nil
		}
	}
	return corevalue.Value{}, fmt.Errorf("unknown test Function")
}
func zigReplyTestResolver() zigReplyResolver {
	o := &Object{kind: &ObjectKind{name: "Meter"}, id: "m1"}
	fn := corevalue.Fields{Kind: corevalue.Function, Function: &corevalue.FunctionData{Home: "s", Code: "f1", CodeState: corevalue.WireFunction{Display: "given"}}}.Value()
	return zigReplyResolver{objects: map[objectKey]*Object{{"Meter", "m1"}: o}, functions: map[string]corevalue.Value{"f1": fn}}
}

func TestZigBackendReplyReaderLayouts(t *testing.T) {
	resolver := zigReplyTestResolver()
	reader := zigReplyReader{resolver: resolver}
	for _, c := range zigReplyFixtures(t) {
		t.Run(c.Name, func(t *testing.T) {
			want, err := reader.read([]byte(c.JSON), 7, c.Sent)
			if err != nil {
				t.Fatal(err)
			}
			if want.completion.err != nil {
				t.Fatal(want.completion.err)
			}
			switch c.Name {
			case "admission refused":
				if !errors.Is(want.failure, ErrMailboxFull) || want.admission.assigned {
					t.Fatalf("refusal: %+v", want)
				}
			case "admission":
				if want.failure != nil || want.admission.delivery != "d1" || !want.admission.assigned {
					t.Fatalf("admission: %+v", want)
				}
			case "Pump failure after admission":
				if want.failure == nil || want.admission != (zigAdmitted{delivery: "d1", token: 9, assigned: true}) {
					t.Fatalf("partial success: %+v", want)
				}
			case "error":
				if e, ok := want.failure.(*HostError); !ok || e.Code != InvalidValue || e.Detail != "bad clock" {
					t.Fatal(want.failure)
				}
			case "need":
				if want.need == nil || want.need.kind != "release" || want.need.script != "s" || want.need.grant != "api" || want.need.reason != "stop" || want.need.nowErr != nil || !want.need.now.Equal(time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)) {
					t.Fatalf("need: %+v", want.need)
				}
			case "completion":
				if want.completion.result.State != Sliced || want.completion.result.FuelUsed != 42 || !reflect.DeepEqual(want.completion.gone, []string{"d2"}) {
					t.Fatalf("completion: %+v", want.completion)
				}
			case "Reports":
				reports := want.completion.result.Reports
				if len(reports) != 12 || len(want.completion.climbed) != 1 || want.completion.climbed[0] != reports[1] {
					t.Fatalf("Reports: %+v", want.completion)
				}
				started := reports[0].(*RunStarted)
				if started.ParentCall != "s/r0.c1" || len(started.Args) != 3 || !started.Args[1].Equal(resolver.objects[objectKey{"Meter", "m1"}].Value()) || !started.Args[2].Equal(Value{resolver.functions["f1"]}) || started.Function == nil || !started.Function.Equal(started.Args[2]) {
					t.Fatalf("Values and ancestry: %+v", started)
				}
			}
			for _, layout := range []struct{ name, wire string }{{"fields", c.Fields}, {"map", c.Map}} {
				t.Run(layout.name, func(t *testing.T) {
					data, err := hex.DecodeString(layout.wire)
					if err != nil {
						t.Fatal(err)
					}
					got, err := reader.read(data, 7, c.Sent)
					if err != nil {
						t.Fatal(err)
					}
					// Callback envelopes are negotiated independently of Request/Pump;
					// only the need's result writer needs its envelope tag.
					if got.need != nil {
						got.need.tag = 0
					}
					if !reflect.DeepEqual(got, want) {
						for i, report := range got.completion.result.Reports {
							if !reflect.DeepEqual(report, want.completion.result.Reports[i]) {
								t.Errorf("report %d: %#v / %#v", i, report, want.completion.result.Reports[i])
							}
						}
						t.Fatalf("decoded %s differs:\ngot  %+v\nwant %+v\ncompletion: %+v / %+v", layout.name, got, want, got.completion, want.completion)
					}
				})
			}
		})
	}
}

func TestZigBackendReplyReaderPauseTransitions(t *testing.T) {
	fixtures := zigReplyFixtures(t)
	for _, c := range fixtures {
		if c.Name == "Reports" {
			continue
		}
		for _, layout := range []struct {
			name string
			data []byte
		}{{"json", []byte(c.JSON)}, {"fields", mustZigReplyHex(t, c.Fields)}, {"map", mustZigReplyHex(t, c.Map)}} {
			for _, paused := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/%s/paused=%v", c.Name, layout.name, paused), func(t *testing.T) {
					reply, err := (zigReplyReader{}).read(layout.data, 7, c.Sent)
					if err != nil {
						t.Fatal(err)
					}
					want := paused
					switch c.Name {
					case "need":
						want = true
					case "completion":
						want = false
					}
					reply.updatePause(&paused)
					if paused != want {
						t.Fatalf("pause %v, want %v", paused, want)
					}
				})
			}
		}
	}
	// JSON continuations carry no completion tag. Keep the compatibility name
	// list, including the names whose successful admissions leave pause alone.
	for _, sent := range []string{"pump", "op-result", "trace-result", "release-result", "resolve-result", "request", "prop-result", "effect-result"} {
		reply, err := (zigReplyReader{}).read([]byte(`{"ref":7,"ok":{}}`), 7, sent)
		if err != nil {
			t.Fatal(err)
		}
		paused := true
		reply.updatePause(&paused)
		want := sent == "request" || sent == "prop-result" || sent == "effect-result"
		if paused != want {
			t.Fatalf("%s: pause %v, want %v", sent, paused, want)
		}
	}
}

func mustZigReplyHex(t *testing.T, wire string) []byte {
	t.Helper()
	data, err := hex.DecodeString(wire)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestZigBackendReplyReaderChecksRefsInEveryLayout(t *testing.T) {
	for _, c := range zigReplyFixtures(t) {
		for _, data := range [][]byte{[]byte(c.JSON), mustZigReplyHex(t, c.Fields), mustZigReplyHex(t, c.Map)} {
			if _, err := (zigReplyReader{}).read(data, 8, c.Sent); err == nil || err.Error() != "Zig reply ref mismatch" {
				t.Fatalf("%s: %v", c.Name, err)
			}
		}
	}
	if _, err := (zigReplyReader{}).read([]byte(`{"ok":{}}`), 7, "load"); err == nil || err.Error() != "Zig reply omitted ref" {
		t.Fatal(err)
	}
}

func TestZigBackendReplyReaderGrantsAndInline(t *testing.T) {
	reader := zigReplyReader{}
	reply, err := reader.read([]byte(`{"ref":7,"ok":{"trace":["operation"]},"trace":["real trace"]}`), 7, "grants")
	if err != nil || !reflect.DeepEqual(reply.trace, []string{"real trace"}) || zigText(reply.body.get("trace").items()[0]) != "operation" {
		t.Fatal(reply, err)
	}
	reply, ack, err := reader.readInline([]byte(`{"reply":{"ref":7,"ok":{"delivery":"d1"}}}`), 7, "request")
	if err != nil || !ack || reply.admission.delivery != "d1" || !reply.admission.assigned {
		t.Fatal(reply, ack, err)
	}
	if _, _, err := reader.readInline([]byte(`{"reply":{"ref":8,"ok":{}}}`), 7, "request"); err == nil {
		t.Fatal("accepted another inline ref")
	}
	event, ack, err := reader.readInline([]byte(`{"need":{"m":"trace"},"trace":["line"],"abandoned":["c1"],"settled":["c2"]}`), 0, "")
	if err != nil || ack || event.need == nil || event.need.kind != "trace" || !reflect.DeepEqual(event.trace, []string{"line"}) || !reflect.DeepEqual(event.abandoned, []string{"c1"}) || !reflect.DeepEqual(event.settled, []string{"c2"}) {
		t.Fatal(event, ack, err)
	}
}

func TestZigBackendReplyReaderAppliesDecodeFailureAtReceipt(t *testing.T) {
	// A completion decode error belongs to the receipt, so admission
	// bookkeeping can precede it. No guest or Group is needed here.
	var fixture zigReplyFixture
	for _, c := range zigReplyFixtures(t) {
		if c.Name == "completion" {
			fixture = c
			break
		}
	}
	if fixture.JSON == "" {
		t.Fatal("missing completion fixture")
	}
	for _, layout := range []struct {
		name string
		data []byte
	}{{"json", []byte(fixture.JSON)}, {"fields", mustZigReplyHex(t, fixture.Fields)}, {"map", mustZigReplyHex(t, fixture.Map)}} {
		t.Run(layout.name, func(t *testing.T) {
			// Replacing a same-length state preserves every binary length and field
			// boundary; all three decoders must retain a payload error, not a refusal.
			data := bytes.ReplaceAll(layout.data, []byte("sliced"), []byte("broken"))
			reply, err := (zigReplyReader{}).read(data, 7, "pump")
			if err != nil || reply.failure != nil || reply.completion.err == nil {
				t.Fatalf("payload failure: %+v, %v", reply, err)
			}
			called := false
			err = applyReceipt(reply, func(got zigResponse) error { called = true; return got.completion.err })
			if !called || err == nil {
				t.Fatal("completion error bypassed its receipt")
			}
		})
	}
}
