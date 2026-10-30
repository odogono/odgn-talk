package northtalk_test

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	talk "northtalk.org/go"
)

// The native Go Core's observations, recorded from its last build before it
// was removed (#1055), are the reference the Zig backend still matches.
// The sqlite query's Fuel was updated when perStep replaced perRow (#1795).
func TestZigBackendCapabilityParity(t *testing.T) {
	dir := t.TempDir()
	recorded, err := os.Open("testdata/native-bridge-observations.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer recorded.Close()
	unzipped, err := gzip.NewReader(recorded)
	if err != nil {
		t.Fatal(err)
	}
	want, err := io.ReadAll(unzipped)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "native.json")
	if err := os.WriteFile(path, want, 0600); err != nil {
		t.Fatal(err)
	}
	actualCases := runBridgeCases(t)
	if t.Failed() {
		return
	}
	got, err := json.MarshalIndent(actualCases, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(want, got) {
		actual := filepath.Join(dir, "actual.json")
		os.WriteFile(actual, got, 0600)
		diff := exec.Command("diff", "-u", path, actual)
		out, _ := diff.CombinedOutput()
		t.Fatalf("public Host parity differs:\n%s", out)
	}
}

func TestZigBackendCallbackInputsAndOnReady(t *testing.T) {
	core := talk.New()
	var g *talk.Group
	var s *talk.Script
	var generated *talk.Pending
	var once atomic.Bool
	var readyEnabled atomic.Bool
	callbacks := 0
	def, err := core.DefineCapability("async", talk.Operation{Name: "read", Mode: talk.Suspending, Result: talk.NumberShape, Start: func(c *talk.Call, args []talk.Value) error {
		callbacks++
		done := make(chan error, 1)
		go func() {
			_, p, err := s.Request(nil, talk.Message{Name: "echo", Args: []talk.Value{talk.Int(6)}})
			generated = p
			if err == nil {
				c.Answer(talk.Int(8))
			}
			done <- err
		}()
		select {
		case err := <-done:
			if err != nil {
				return err
			}
		case <-time.After(5 * time.Second):
			return fmt.Errorf("concurrent callback input deadlocked")
		}
		return nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	g = core.NewGroup(talk.GroupOptions{OnReady: func() {
		// Reentry is refused outside locks; a notification may queue another input.
		if readyEnabled.Load() && once.CompareAndSwap(false, true) {
			if _, err := g.Pump(time.Unix(1, 0), talk.PumpOptions{}); !isReentrant(err) {
				t.Errorf("OnReady worker: %v", err)
			}
			if _, err := s.Deliver(talk.Message{Name: "echo", Args: []talk.Value{talk.Int(7)}}); err != nil {
				t.Error(err)
			}
		}
	}})
	s, err = g.Load(talk.LoadOptions{Name: "s", Source: "on go\n ask api to read and wait\n return it\nend go\non echo x\n return x\nend echo", Grants: map[string]*talk.Grant{"api": def.GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := s.Request(nil, talk.Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	readyEnabled.Store(true)
	if _, err = g.Pump(time.Unix(1, 0), talk.PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-generated.Done():
		t.Fatal("callback input ran in the same Pump")
	default:
	}
	if _, err = g.Pump(time.Unix(1, 0), talk.PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	v, e := p.Result()
	if e != nil || !v.Equal(talk.Int(8)) || callbacks != 1 || !once.Load() {
		t.Fatal(v, e, callbacks, once.Load())
	}
	v, e = generated.Result()
	if e != nil || !v.Equal(talk.Int(6)) {
		t.Fatal(v, e)
	}
}

func TestZigBackendGrantRoutingAndLoadChecks(t *testing.T) {
	core := talk.New()
	var calls []string
	define := func(result int64) *talk.CapabilityDef {
		def, err := core.DefineCapability("same name", talk.Operation{Name: "read", Args: []talk.Shape{talk.NumberShape}, Result: talk.NumberShape, Do: func(c *talk.Call, args []talk.Value) (talk.Value, error) {
			calls = append(calls, fmt.Sprintf("%s/%s/%s/%v", c.Group().Name(), c.ScriptName(), c.GrantName(), c.Binding()))
			return talk.Int(result), nil
		}}, talk.Operation{Name: "unused", Do: func(*talk.Call, []talk.Value) (talk.Value, error) {
			t.Fatal("ungranted callback")
			return talk.Nothing, nil
		}})
		if err != nil {
			t.Fatal(err)
		}
		return def
	}
	a, b := define(1), define(2)
	for _, groupName := range []string{"one", "two"} {
		g := core.NewGroup(talk.GroupOptions{Name: groupName})
		for i, def := range []*talk.CapabilityDef{a, b} {
			grant, err := def.Grant([]string{"read"}, i)
			if err != nil {
				t.Fatal(err)
			}
			s, err := g.Load(talk.LoadOptions{Name: fmt.Sprint(i), Source: "on go\n ask first to read 4\n ask second to read 4\n return it\nend go", Grants: map[string]*talk.Grant{"first": grant, "second": grant}})
			if err != nil {
				t.Fatal(err)
			}
			if got := s.Grants(); !reflect.DeepEqual(got, map[string][]string{"first": {"read"}, "second": {"read"}}) {
				t.Fatal(got)
			}
			_, p, err := s.Request(nil, talk.Message{Name: "go"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = g.Pump(bridgeNow, talk.PumpOptions{}); err != nil {
				t.Fatal(err)
			}
			v, e := p.Result()
			if e != nil || !v.Equal(talk.Int(int64(i+1))) {
				t.Fatal(v, e)
			}
		}
		for _, source := range []string{"on go\n ask api to unused\nend go", "on go\n ask api to read \"bad\"\nend go", "on go\n ask api to read 4 and wait\nend go"} {
			grant, _ := a.Grant([]string{"read"}, nil)
			_, err := g.Load(talk.LoadOptions{Name: "refused", Source: source, Grants: map[string]*talk.Grant{"api": grant}})
			var load *talk.LoadError
			if !errors.As(err, &load) || g.Script("refused") != nil {
				t.Fatal(err)
			}
		}
	}
	want := []string{"one/0/first/0", "one/0/second/0", "one/1/first/1", "one/1/second/1", "two/0/first/0", "two/0/second/0", "two/1/first/1", "two/1/second/1"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatal(calls)
	}
}

func TestZigBackendCapabilityShapesAndData(t *testing.T) {
	const encoded = `[null,true,-3,{"$dec":"3.0"},{"$dec":"9007199254740992"},"é<>\u000a",{"$quantity":["2.50","GBP"]},{"$bytes":"DQo="},{"$range":[3,7]},{"$date":"2026-09-27T14:30:00.5"},{"$instant":"1969-12-31T23:59:59.999999Z"},{"$pattern":"<\"a\">"},{"$map":[["$ref",1],["é",[null,true]]]}]`
	data, err := talk.DecodeValue([]byte(encoded), nil)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := talk.Map(talk.KV("items", data), talk.KV("extra", talk.Int(1)))
	shape := talk.OpenMap(talk.Field{Key: "items", Shape: talk.ListOf(talk.AnyShape)}, talk.Field{Key: "maybe", Shape: talk.OneOf(talk.NumberShape, talk.TextShape), Optional: true})
	for _, mode := range []talk.Mode{talk.Immediate, talk.Suspending} {
		core := talk.New()
		op := talk.Operation{Name: "echo", Mode: mode, Args: []talk.Shape{shape, talk.Optional(talk.TextShape)}, Result: shape}
		callback := func(args []talk.Value) talk.Value {
			if len(args) != 1 || !args[0].Equal(payload) {
				t.Fatal(args)
			}
			return args[0]
		}
		if mode == talk.Immediate {
			op.Do = func(c *talk.Call, args []talk.Value) (talk.Value, error) { return callback(args), nil }
		} else {
			op.Start = func(c *talk.Call, args []talk.Value) error { c.Answer(callback(args)); return nil }
		}
		def, err := core.DefineCapability("echo", op, talk.Operation{Name: "unused", Do: func(*talk.Call, []talk.Value) (talk.Value, error) {
			t.Fatal("unused callback")
			return talk.Nothing, nil
		}})
		if err != nil {
			t.Fatal(err)
		}
		g := core.NewGroup(talk.GroupOptions{})
		wait := ""
		if mode == talk.Suspending {
			wait = " and wait"
		}
		s, err := g.Load(talk.LoadOptions{Name: "s", Source: "on echo x\n ask api to echo x" + wait + "\n return it\nend echo", Grants: map[string]*talk.Grant{"api": def.GrantAll(nil)}, GrantsAsUsed: true})
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(s.Grants(), map[string][]string{"api": {"echo"}}) {
			t.Fatal(s.Grants())
		}
		_, p, err := s.Request(nil, talk.Message{Name: "echo", Args: []talk.Value{payload}})
		if err != nil {
			t.Fatal(err)
		}
		for range 2 {
			if _, err = g.Pump(bridgeNow, talk.PumpOptions{}); err != nil {
				t.Fatal(err)
			}
		}
		v, e := p.Result()
		if e != nil || !v.Equal(payload) {
			t.Fatal(v, e)
		}
	}
}

func TestZigBackendReadySettlementStillCancelsBeforeFollowingCallback(t *testing.T) {
	core := talk.New()
	var call *talk.Call
	observed := false
	def, err := core.DefineCapability("api", talk.Operation{Name: "fetch", Mode: talk.Suspending, Result: talk.NumberShape, Start: func(c *talk.Call, _ []talk.Value) error { call = c; return nil }}, talk.Operation{Name: "observe", Do: func(*talk.Call, []talk.Value) (talk.Value, error) {
		if call.Context().Err() == nil {
			t.Fatal("ready settlement lost cancellation before next callback")
		}
		observed = true
		return talk.Nothing, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	g := core.NewGroup(talk.GroupOptions{})
	s, err := g.Load(talk.LoadOptions{Name: "s", Source: "on go\n ask api to fetch and wait\n return it\nend go\non other\n return 0\nend other", Grants: map[string]*talk.Grant{"api": def.GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	next, err := g.Load(talk.LoadOptions{Name: "next", Source: "on go\n ask api to observe\nend go", Grants: map[string]*talk.Grant{"api": def.GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Deliver(talk.Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	if _, err = g.Pump(bridgeNow, talk.PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Deliver(talk.Message{Name: "other"}); err != nil {
		t.Fatal(err)
	}
	call.Answer(talk.Int(9))
	if _, err = g.Pump(bridgeNow, talk.PumpOptions{FuelCap: 7}); err != nil {
		t.Fatal(err)
	}
	view := g.Inspect().Scripts[0].Runs
	if len(view) != 1 || view[0].Status != talk.Ready || call.Context().Err() != nil {
		t.Fatal(view, call.Context().Err())
	}
	s.Stop("before resumption")
	if _, err = next.Deliver(talk.Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	if _, err = g.Pump(bridgeNow, talk.PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if !observed {
		t.Fatal("following callback did not execute")
	}
}

func TestZigBackendGrantNamedTrace(t *testing.T) {
	core := talk.New()
	def, err := core.DefineCapability("api", talk.Operation{Name: "read", Do: func(*talk.Call, []talk.Value) (talk.Value, error) { return talk.Nothing, nil }})
	if err != nil {
		t.Fatal(err)
	}
	var trace zigTrace
	g := core.NewGroup(talk.GroupOptions{Trace: &trace})
	s, err := g.Load(talk.LoadOptions{Name: "s", Source: "on go\n ask trace to read\nend go", Grants: map[string]*talk.Grant{"trace": def.GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Grants(); !reflect.DeepEqual(got, map[string][]string{"trace": {"read"}}) {
		t.Fatal(got)
	}
	for _, line := range trace {
		if line == "read" {
			t.Fatal("Grant operation was published as a Trace record")
		}
	}
}

// Maintainer decision on #1050: these remain explicit experimental limits.
func TestZigBackendDeliberateDeclarationLimits(t *testing.T) {
	core := talk.New()
	g := core.NewGroup(talk.GroupOptions{})
	first, err := core.DefineObjectKind(talk.ObjectKindDef{Name: "same"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = g.Object(first, "one", nil); err != nil {
		t.Fatal(err)
	}
	second, err := core.DefineObjectKind(talk.ObjectKindDef{Name: "same"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = g.Object(second, "two", nil); err == nil || !strings.Contains(err.Error(), "two Object Kinds") {
		t.Fatal(err)
	}

	deep := talk.TextShape
	for range 34 {
		deep = talk.ListOf(deep)
	}
	def, err := core.DefineCapability("deep", talk.Operation{Name: "read", Result: deep, Do: func(*talk.Call, []talk.Value) (talk.Value, error) { return talk.Nothing, nil }})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = g.Load(talk.LoadOptions{Name: "deep", Grants: map[string]*talk.Grant{"api": def.GrantAll(nil)}}); err == nil || !strings.Contains(err.Error(), "32 levels") {
		t.Fatal(err)
	}

	var refusal error
	def, err = core.DefineCapability("callback", talk.Operation{Name: "make", Result: talk.AnyShape, Do: func(c *talk.Call, _ []talk.Value) (talk.Value, error) {
		kind, err := core.DefineObjectKind(talk.ObjectKindDef{Name: "late"})
		if err != nil {
			return talk.Nothing, err
		}
		_, refusal = c.Group().Object(kind, "new", nil)
		return talk.Nothing, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	s, err := g.Load(talk.LoadOptions{Name: "callback", Source: "on go\nask api to make\nend go", Grants: map[string]*talk.Grant{"api": def.GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Deliver(talk.Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	if _, err = g.Pump(bridgeNow, talk.PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if refusal == nil || !strings.Contains(refusal.Error(), "during a Host callback") {
		t.Fatal(refusal)
	}
}

func TestZigBackendUnusedSegmentLifecycle(t *testing.T) {
	core := talk.New()
	hook := func(talk.SegmentContext) talk.EffectResult {
		t.Fatal("unused lifecycle ran")
		return talk.EffectResult{}
	}
	def, err := core.DefineSegmentCapability("ordinary", talk.SegmentLifecycle{Begin: hook, Commit: hook, Rollback: hook}, talk.Operation{Name: "read", Result: talk.NothingShape, Do: func(*talk.Call, []talk.Value) (talk.Value, error) { return talk.Nothing, nil }})
	if err != nil {
		t.Fatal(err)
	}
	g := core.NewGroup(talk.GroupOptions{})
	s, err := g.Load(talk.LoadOptions{Name: "s", Source: "on go\nask api to read\nend go", Grants: map[string]*talk.Grant{"api": def.GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Deliver(talk.Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	if _, err = g.Pump(bridgeNow, talk.PumpOptions{}); err != nil {
		t.Fatal(err)
	}
}
