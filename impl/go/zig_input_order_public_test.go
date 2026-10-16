package northtalk_test

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// Discover the records each public Host produces, then queue inputs from the
// first occurrence of every kind. The independent native binary discovers the
// same matrix, and supplies exact Trace/Fuel/report/future/state expectations.
func runInputOrderBridgeCases(t *testing.T) []bridgeObservation {
	t.Helper()
	var out []bridgeObservation
	fixtures := []struct {
		name, body string
		options    talk.PumpOptions
		limits     talk.Limits
	}{
		{name: "plain", body: "put 9 into n\n return n"},
		{name: "crossing", body: "ask api to read\n return it"},
		{name: "flow", body: "try\n throw {code: \"mine\"}\n catch e\n put 1 into n\n end try\n send echo to me\n wait 1 ms\n return n"},
		{name: "preempt", body: "put 9 into n\n return n", options: talk.PumpOptions{FuelSlice: 5}},
		{name: "property", body: "get the watts of meter\n return it"},
		{name: "guard", body: "return 1"},
		{name: "unhandled", body: "send missing to me\n return 1"},
		{name: "Host failure", body: "ask api to read\n return it"},
		{name: "abandon", body: "ask api to read and wait\n return it"},
		{name: "cleanup", body: "try\n repeat forever\n end repeat\n finally\n put 1 into n\n end try", options: talk.PumpOptions{FuelSlice: 15}, limits: talk.Limits{CleanupBudget: 1}},
		{name: "fault", body: "put 9 into n\n return n", limits: talk.Limits{FuelPerRun: 7}},
	}
	for _, fixture := range fixtures {
		run := func(t *testing.T, kind, action string) bridgeObservation {
			observation := bridgeObservation{Name: fmt.Sprintf("input order %s/%s/%s", fixture.name, kind, action)}
			var trace bridgeTrace
			core := talk.New()
			op := talk.Operation{Name: "read", Result: talk.NumberShape, Do: func(*talk.Call, []talk.Value) (talk.Value, error) { return talk.Int(9), nil }}
			if fixture.name == "Host failure" {
				op.Do = func(*talk.Call, []talk.Value) (talk.Value, error) {
					return talk.Nothing, errors.New("private Host detail")
				}
			}
			if fixture.name == "abandon" {
				op.Do = nil
				op.Mode = talk.Suspending
				op.Start = func(*talk.Call, []talk.Value) error { return nil }
			}
			def, err := core.DefineCapability("api", op)
			if err != nil {
				t.Fatal(err)
			}
			g := core.NewGroup(talk.GroupOptions{Trace: &trace})
			kindDef, err := core.DefineObjectKind(talk.ObjectKindDef{Name: "meter", Props: []talk.Prop{{Name: "watts", Shape: talk.NumberShape, Get: func(*talk.Object) (talk.Value, error) { return talk.Int(4), nil }}}})
			if err != nil {
				t.Fatal(err)
			}
			meter, err := g.Object(kindDef, "m", nil)
			if err != nil {
				t.Fatal(err)
			}
			prefix := ""
			if fixture.name == "guard" {
				prefix = "on go where 1 / 0 = 0\n return 0\nend go\n"
			}
			s, err := g.Load(talk.LoadOptions{Name: "s", Source: "script variable n = 0\n" + prefix + "on go\n " + fixture.body + "\nend go\non echo\n return 3\nend echo\non choose, deciding\n return 1\nend choose", Limits: fixture.limits, Grants: map[string]*talk.Grant{"api": def.GrantAll(nil)}, Objects: map[string]*talk.Object{"meter": meter}})

			if err != nil {
				t.Fatal(err)
			}
			start := len(trace.lines)
			var generated *talk.Pending
			triggered := false
			trace.record = func(line string) {
				if triggered || kind == "" || bridgeRecordKind(line) != kind {
					return
				}
				triggered = true
				switch action {
				case "stop":
					s.Stop("trace")
				case "request":
					_, generated, err = s.Request(nil, talk.Message{Name: "echo"})
					if err != nil {
						t.Error(err)
					}
				case "revoke":
					s.Revoke("api")
				case "refusal":
					_, e := s.Deliver(talk.Message{Name: "bad:selector:"})
					if e == nil {
						t.Error("invalid selector admitted")
					}
					if _, e := g.Pump(bridgeNow, talk.PumpOptions{}); !isReentrant(e) {
						t.Error(e)
					}
				}
			}
			_, p, err := s.Request(nil, talk.Message{Name: "go"})
			if err != nil {
				t.Fatal(err)
			}
			pumpCount := 0
			pump := func(options talk.PumpOptions) {
				pumpCount++
				result, err := g.Pump(bridgeNow.Add(time.Duration(pumpCount)*time.Millisecond), options)
				if err != nil {
					t.Fatal(err)
				}
				observation.Pumps = append(observation.Pumps, bridgeCanonical(reflect.ValueOf(result)))
			}
			pump(fixture.options)
			if fixture.name == "cleanup" {
				s.CancelRun("s/r1")
			}
			if fixture.name == "abandon" {
				s.Stop("abandon")
			}
			_, decision, e := s.Decide(nil, talk.Message{Name: "choose"})
			if e != nil {
				t.Fatal(e)
			}
			pump(talk.PumpOptions{})
			observation.Pumps = append(observation.Pumps, bridgeCanonical(reflect.ValueOf(decision.Decided())))
			// Refused loads exercise diagnostics while the observer is active.
			_, loadErr := g.Load(talk.LoadOptions{Name: "bad", Source: "on go\n ?\nend go"})
			if loadErr == nil {
				t.Fatal("invalid load accepted")
			}
			observation.Pumps = append(observation.Pumps, bridgeCanonical(reflect.ValueOf(loadErr)))
			observation.Pumps = append(observation.Pumps, bridgeCanonical(reflect.ValueOf(s.Counters())), bridgeCanonical(reflect.ValueOf(g.Inspect())))
			s.RewindRun("s/r999")
			pump(talk.PumpOptions{})
			pump(talk.PumpOptions{})
			for _, future := range []*talk.Pending{p, generated} {
				if future == nil {
					continue
				}
				select {
				case <-future.Done():
					v, e := future.Result()
					observation.Values = append(observation.Values, v.String())
					if e != nil {
						observation.Values = append(observation.Values, e.Code, e.Data.String())
					}
				default:
					observation.Values = append(observation.Values, "open")
				}
			}
			observation.Pumps = append(observation.Pumps, bridgeCanonical(reflect.ValueOf(g.Inspect())))
			if kind != "" && !triggered {
				t.Fatalf("record %q was never observed", kind)
			}
			observation.Trace = append([]string{}, trace.lines[start:]...)
			return observation
		}
		t.Run("input order "+fixture.name, func(t *testing.T) {
			baseline := run(t, "", "")
			out = append(out, baseline)
			seen := map[string]bool{}
			for _, line := range baseline.Trace {
				kind := bridgeRecordKind(line)
				if seen[kind] {
					continue
				}
				seen[kind] = true
				for _, action := range []string{"stop", "request", "revoke", "refusal"} {
					// Native Go panics on this combination; tracked in #1072.
					if kind == "pumped" && action == "refusal" {
						continue
					}
					t.Run(kind+"/"+action, func(t *testing.T) { out = append(out, run(t, kind, action)) })
				}
			}
		})
	}
	return out
}

func bridgeRecordKind(line string) string {
	fields := strings.Fields(line)
	if fields[0] == ">" {
		return "> " + fields[1]
	}
	return fields[0]
}

// A deterministic goroutine schedule lets the separately compiled native Host
// compare admission ids and the full observable order, rather than comparing
// two unrelated scheduler interleavings. The Trace-disabled stress test covers
// inputs arriving while guest instructions themselves are running.
func runConcurrentInputBridgeCase(t *testing.T) bridgeObservation {
	t.Helper()
	o := bridgeObservation{Name: "concurrent input order"}
	core := talk.New()
	var trace bridgeTrace
	var call *talk.Call
	def, err := core.DefineCapability("api", talk.Operation{Name: "read", Mode: talk.Suspending, Result: talk.NumberShape, Start: func(c *talk.Call, _ []talk.Value) error { call = c; return nil }})
	if err != nil {
		t.Fatal(err)
	}
	var notifications atomic.Int64
	g := core.NewGroup(talk.GroupOptions{Trace: &trace, OnReady: func() { notifications.Add(1) }})
	load := func(name, source string, grants map[string]*talk.Grant) *talk.Script {
		s, e := g.Load(talk.LoadOptions{Name: name, Source: source, Grants: grants})
		if e != nil {
			t.Fatal(e)
		}
		return s
	}
	waiting := load("waiting", "on go\n ask api to read and wait\n return it\nend go", map[string]*talk.Grant{"api": def.GrantAll(nil)})
	_, answer, err := waiting.Request(nil, talk.Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	pump := func() {
		r, e := g.Pump(bridgeNow, talk.PumpOptions{})
		if e != nil {
			t.Fatal(e)
		}
		o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(r)))
	}
	pump()
	busy := load("busy", "on go\n repeat 100 times\n end repeat\nend go", nil)
	target := load("target", "on echo x\n return x\nend echo", nil)
	victim := load("victim", "", nil)
	const workers = 32
	turns := make([]chan struct{}, workers+1)
	for i := range turns {
		turns[i] = make(chan struct{})
	}
	futures := make([]*talk.Pending, workers)
	ids := make([]talk.DeliveryID, workers)
	errs := make([]error, workers)
	for i := range workers {
		go func() {
			<-turns[i]
			switch i {
			case 0:
				call.Answer(talk.Int(5))
			case 1:
				victim.Stop("ordered")
			case 2:
				victim.CancelRun("victim/r999")
			default:
				ids[i], futures[i], errs[i] = target.Request(nil, talk.Message{Name: "echo", Args: []talk.Value{talk.Int(int64(i))}})
			}
			close(turns[i+1])
		}()
	}
	triggered := false
	trace.record = func(line string) {
		if !triggered && strings.HasPrefix(line, "> pump") {
			triggered = true
			close(turns[0])
			select {
			case <-turns[workers]:
			case <-time.After(10 * time.Second):
				t.Error("sink input admission deadlocked")
			}
		}
	}
	if _, err = busy.Deliver(talk.Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	before := notifications.Load()
	pump()
	if !triggered {
		t.Fatal("sink did not run")
	}
	for i, p := range futures {
		if errs[i] != nil {
			t.Fatal(errs[i])
		}
		if p != nil {
			select {
			case <-p.Done():
				t.Fatal("concurrent input ran in the admitting Pump")
			default:
			}
		}
	}
	select {
	case <-answer.Done():
		t.Fatal("concurrent Answer resumed in the admitting Pump")
	default:
	}
	o.Values = append(o.Values, fmt.Sprint(notifications.Load()-before))
	pump()
	for i, p := range futures {
		if p == nil {
			continue
		}
		select {
		case <-p.Done():
		default:
			t.Fatalf("future %d did not settle", i)
		}
		v, e := p.Result()
		if e != nil {
			t.Fatal(e)
		}
		o.Values = append(o.Values, string(ids[i]), v.String())
	}
	select {
	case <-answer.Done():
	default:
		t.Fatal("Answer did not settle")
	}
	v, e := answer.Result()
	if e != nil {
		t.Fatal(e)
	}
	o.Values = append(o.Values, v.String())
	o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(g.Inspect())))
	o.Trace = append([]string{}, trace.lines...)
	return o
}
