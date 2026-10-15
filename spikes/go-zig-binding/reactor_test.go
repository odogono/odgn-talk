package zigprobe

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
)

var engine *Engine

func TestMain(m *testing.M) {
	var err error
	engine, err = NewEngine(context.Background())
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	code := m.Run()
	if err := engine.Close(context.Background()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		code = 1
	}
	os.Exit(code)
}

type obj = map[string]any
type host struct {
	t   testing.TB
	r   *Reactor
	ref int
}

func newHost(t testing.TB) *host {
	t.Helper()
	r, err := engine.Instantiate(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := r.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	h := &host{t: t, r: r}
	h.ok("hello", obj{"protocol": 1})
	return h
}
func (h *host) frame(m string, f obj, next bool) obj {
	h.t.Helper()
	if next {
		h.ref++
	}
	data := obj{"m": m, "ref": h.ref}
	for k, v := range f {
		data[k] = v
	}
	b, err := json.Marshal(data)
	if err != nil {
		h.t.Fatal(err)
	}
	b, err = h.r.Frame(context.Background(), b)
	if err != nil {
		h.t.Fatal(err)
	}
	var result obj
	if err := json.Unmarshal(b, &result); err != nil {
		h.t.Fatal(err)
	}
	if result["ref"] != float64(h.ref) {
		h.t.Fatalf("wrong ref: %s", b)
	}
	return result
}
func field(t testing.TB, r obj, key string) obj {
	t.Helper()
	v, ok := r[key].(map[string]any)
	if !ok {
		t.Fatalf("missing %s: %v", key, r)
	}
	return v
}
func (h *host) ok(m string, f obj) obj     { h.t.Helper(); return field(h.t, h.frame(m, f, true), "ok") }
func (h *host) result(m string, f obj) obj { h.t.Helper(); return h.frame(m, f, false) }
func (h *host) setup(mode, source string)  { h.setupTrace(mode, source, false) }
func (h *host) setupTrace(mode, source string, trace bool) {
	operation := obj{"name": "read", "mode": mode, "result": "number"}
	if mode == "suspending" {
		operation["maxPending"] = 5000
	}
	h.ok("define-capability", obj{"name": "api", "ops": []obj{operation}})
	grant := h.ok("grant", obj{"capability": "api", "ops": "all"})["grant"]
	h.ok("new-group", obj{"group": "g", "name": "g", "trace": trace})
	h.ok("load", obj{"group": "g", "name": "s", "source": source, "grants": obj{"api": grant}})
}
func (h *host) request(group string) {
	h.ok("request", obj{"group": group, "to": obj{"script": "s"}, "message": obj{"name": "go"}})
}
func (h *host) pump(group string) obj {
	return h.frame("pump", obj{"group": group, "now": "2026-10-14T12:00:00Z"}, true)
}
func end(t testing.TB, r obj) obj {
	t.Helper()
	for _, v := range field(t, r, "ok")["reports"].([]any) {
		row := v.(map[string]any)
		if row["kind"] == "run end" {
			return row
		}
	}
	t.Fatalf("no run end: %v", r)
	return nil
}
func TestArtifact(t *testing.T) {
	data, err := os.ReadFile("artifact.json")
	if err != nil {
		t.Fatal(err)
	}
	var meta struct {
		SHA256 string `json:"sha256"`
	}
	if err = json.Unmarshal(data, &meta); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(wasm)
	if hex.EncodeToString(digest[:]) != meta.SHA256 {
		t.Fatal("artifact digest differs")
	}
	h := newHost(t)
	hello := h.ok("hello", obj{"protocol": 1})
	versions := talk.CoreVersions()
	if hello["language"] != versions.Language || hello["costModel"] != versions.CostModel || hello["unicode"] != versions.Unicode {
		t.Fatalf("version mismatch: %v vs %v", hello, versions)
	}
	t.Logf("artifact=%s bytes=%d memory=%d hello=%v", meta.SHA256, len(wasm), h.r.MemoryBytes(), hello)
}
func TestImmediateAndDeferredAnswers(t *testing.T) {
	for _, mode := range []string{"immediate", "suspending"} {
		t.Run(mode, func(t *testing.T) {
			h := newHost(t)
			wait := ""
			if mode == "suspending" {
				wait = " and wait"
			}
			h.setup(mode, "on go\n ask api to read"+wait+"\n return it + 1\nend go")
			h.request("g")
			need := field(t, h.pump("g"), "need")
			if need["m"] != "op" || need["mode"] != mode {
				t.Fatal(need)
			}
			var done obj
			if mode == "immediate" {
				done = h.result("op-result", obj{"result": 41})
			} else {
				field(t, h.result("op-result", obj{"started": true}), "ok")
				// Actually answer from a later goroutine, after the first Pump has returned.
				finished := make(chan struct{})
				go func() { defer close(finished); h.ok("answer", obj{"group": "g", "call": need["call"], "value": 41}) }()
				<-finished
				done = h.pump("g")
			}
			row := end(t, done)
			if row["outcome"] != "completed" || row["result"] != float64(42) {
				t.Fatal(row)
			}
		})
	}
}

const stopSource = "script variable n = 0\non go\n put 9 into n\n ask api to read\n put 8 into n\n return n\nend go"

type traceLines []string

func (l *traceLines) Record(line string) { *l = append(*l, line) }

// The embedded artifact must pass the original failed gate, with the same
// Script, Clock, callback result and crossing inputs as native Go.
func TestStopAtCrossingParity(t *testing.T) {
	for _, mode := range []string{"immediate", "suspending"} {
		for _, result := range []string{"value", "wrong shape", "failure", "host error"} {
			if mode == "suspending" && result != "value" {
				continue
			}
			t.Run(mode+"/"+result, func(t *testing.T) {
				core := talk.New()
				op := talk.Operation{Name: "read", Mode: talk.Immediate, Result: talk.NumberShape}
				stop := func(c *talk.Call) { c.Group().Script(c.ScriptName()).Stop("crossing") }
				reply := obj{"result": 7}
				if mode == "suspending" {
					op.Mode = talk.Suspending
					op.MaxPending = 5 * time.Second
					op.Start = func(c *talk.Call, _ []talk.Value) error { stop(c); return nil }
					reply = obj{"started": true}
				} else {
					op.Do = func(c *talk.Call, _ []talk.Value) (talk.Value, error) {
						stop(c)
						switch result {
						case "wrong shape":
							return talk.Text("bad")
						case "failure":
							return talk.Nothing, &talk.ScriptError{Code: "bad"}
						case "host error":
							return talk.Nothing, fmt.Errorf("broken")
						}
						return talk.Int(7), nil
					}
					switch result {
					case "wrong shape":
						reply = obj{"result": "bad"}
					case "failure":
						reply = obj{"fail": obj{"code": "bad"}}
					case "host error":
						reply = obj{"hostError": "broken"}
					}
				}
				def, err := core.DefineCapability("api", op)
				if err != nil {
					t.Fatal(err)
				}
				var trace traceLines
				g := core.NewGroup(talk.GroupOptions{Trace: &trace})
				source := stopSource
				if mode == "suspending" {
					source = strings.Replace(source, "ask api to read", "ask api to read and wait", 1)
				}
				script, err := g.Load(talk.LoadOptions{Name: "s", Source: source, Grants: map[string]*talk.Grant{"api": def.GrantAll(nil)}})
				if err != nil {
					t.Fatal(err)
				}
				trace = nil
				if _, _, err = script.Request(nil, talk.Message{Name: "go"}); err != nil {
					t.Fatal(err)
				}
				native, err := g.Pump(time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC), talk.PumpOptions{})
				if err != nil {
					t.Fatal(err)
				}
				nativeTrace := append(traceLines(nil), trace...)
				if native.State != talk.Stopped || g.Inspect().Scripts[0].Vars[0].Val.String() != "0" {
					t.Fatal("native Stop did not roll back")
				}
				h := newHost(t)
				hello := h.ok("hello", obj{"protocol": 1})
				if !strings.Contains(fmt.Sprint(hello["features"]), "paused-inputs-v1") {
					t.Fatal("artifact lacks paused-inputs-v1", hello)
				}
				h.setupTrace(mode, source, true)
				h.request("g")
				field(t, h.pump("g"), "need")
				worker := h.ref
				admitted := h.ok("stop", obj{"group": "g", "script": "s", "reason": "crossing"})
				if _, ok := admitted["trace"]; ok {
					t.Fatal("premature callback Trace", admitted)
				}
				h.ref = worker
				done := field(t, h.result("op-result", reply), "ok")
				if done["state"] != "stopped" || done["fuelUsed"] != float64(native.FuelUsed) {
					t.Fatal(done, native)
				}
				var got []string
				for _, line := range done["trace"].([]any) {
					got = append(got, line.(string))
				}
				if strings.Join(got, "\n") != strings.Join(nativeTrace, "\n") {
					t.Fatalf("Trace differs\nnative:\n%s\nZig:\n%s", strings.Join(nativeTrace, "\n"), strings.Join(got, "\n"))
				}
				inspection := h.ok("inspect", obj{"group": "g"})
				b, _ := json.Marshal(inspection)
				if !bytes.Contains(b, []byte(`"vars":[["n",0]]`)) {
					t.Fatal(string(b))
				}
			})
		}
	}
}
func TestRetainedRepliesAndConcurrentInstances(t *testing.T) {
	for i := 0; i < 4; i++ {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			t.Parallel()
			var wg sync.WaitGroup
			h := newHost(t)
			first, err := h.r.Frame(context.Background(), []byte(`{"m":"add","ref":1,"a":20,"b":22}`))
			if err != nil {
				t.Fatal(err)
			}
			copyOfFirst := append([]byte(nil), first...)
			before := h.r.MemoryBytes()
			large := []byte(`{"m":"hello","ref":2,"protocol":1}` + strings.Repeat(" ", 4<<20))
			if _, err = h.r.Frame(context.Background(), large); err != nil {
				t.Fatal(err)
			}
			if h.r.MemoryBytes() <= before {
				t.Fatal("test did not grow guest memory")
			}
			if !bytes.Equal(first, copyOfFirst) {
				t.Fatal("retained reply changed")
			}
			// Export calls alone are serialized safely even when Go goroutines race.
			for j := 0; j < 4; j++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					_, err := h.r.Frame(context.Background(), []byte(`{"m":"add","ref":3,"a":1,"b":2}`))
					if err != nil {
						t.Error(err)
					}
				}()
			}
			wg.Wait()
		})
	}
}
func TestSaveRestore(t *testing.T) {
	h := newHost(t)
	h.ok("new-group", obj{"group": "g", "name": "g"})
	h.ok("load", obj{"group": "g", "name": "s", "source": "script variable n = 42\non go\n return n\nend go"})
	saved := h.ok("save", obj{"group": "g"})["save"]
	h.ok("restore", obj{"group": "restored", "name": "g", "save": saved})
	h.request("restored")
	if row := end(t, h.pump("restored")); row["result"] != float64(42) {
		t.Fatal(row)
	}
}
