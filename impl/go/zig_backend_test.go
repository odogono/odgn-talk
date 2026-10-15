//go:build talk_zig_experimental

package northtalk_test

import (
	"bytes"
	"context"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
)

type zigTrace []string

func (s *zigTrace) Record(line string) { *s = append(*s, line) }

func TestZigBackendRequest(t *testing.T) {
	if !strings.HasPrefix(talk.CoreVersions().Core, "zig/") {
		t.Fatal("experimental backend did not select Zig", talk.CoreVersions())
	}
	var trace zigTrace
	g := talk.New().NewGroup(talk.GroupOptions{Name: "test", Trace: &trace})
	s, err := g.Load(talk.LoadOptions{Name: "math", Source: "script variable total\non sum a, b\n put a + b into total\n return total\nend sum\n"})
	if err != nil {
		t.Fatal(err)
	}
	id, p, err := s.Request(context.Background(), talk.Message{Name: "sum", Args: []talk.Value{talk.Int(2), talk.Int(3)}})
	if err != nil || id != "d1" {
		t.Fatal(id, err)
	}
	result, err := g.Pump(time.Date(2026, 9, 30, 9, 0, 0, 0, time.UTC), talk.PumpOptions{})
	if err != nil || result.State != talk.Idle || result.FuelUsed != 15 {
		t.Fatal(result, err)
	}
	select {
	case <-p.Done():
	default:
		t.Fatal("Request did not settle")
	}
	value, failure := p.Result()
	if failure != nil || !value.Equal(talk.Int(5)) {
		t.Fatal(value, failure)
	}
	found := false
	for _, report := range result.Reports {
		if end, ok := report.(*talk.RunEnd); ok {
			found = true
			if end.Delivery != id || end.Script != "math" || end.Outcome != talk.Completed || !end.Result.Equal(value) {
				t.Fatal(end)
			}
		}
	}
	if !found {
		t.Fatal("missing typed RunEnd")
	}
	if len(trace) == 0 || !strings.HasPrefix(trace[0], "> load math identity=") {
		t.Fatal(trace)
	}
	if g.Name() != "test" || g.Script("math") != s || s.Name() != "math" {
		t.Fatal("Group/Script identity changed")
	}
}

func TestZigBackendInspection(t *testing.T) {
	g := talk.New().NewGroup(talk.GroupOptions{})
	s, err := g.Load(talk.LoadOptions{Name: "math", Source: "script variable total\non sum a, b\n put a + b into total\n return total\nend sum\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Deliver(talk.Message{Name: "sum", Args: []talk.Value{talk.Int(2), talk.Int(3)}})
	if err != nil {
		t.Fatal(err)
	}
	before := g.Inspect()
	if len(before.Scripts) != 1 || len(before.Scripts[0].Mailbox) != 0 || !before.Scripts[0].Vars[0].Val.Equal(talk.Nothing) {
		t.Fatal(before)
	}
	if _, err = g.Pump(time.Unix(1, 0), talk.PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	after := g.Inspect()
	if len(after.Scripts[0].Vars) != 1 || after.Scripts[0].Vars[0].Key != "total" || !after.Scripts[0].Vars[0].Val.Equal(talk.Int(5)) || len(after.Scripts[0].Mailbox) != 0 {
		t.Fatal(after)
	}
	counters := s.Counters()
	if counters.Runs != 1 || counters.FuelTotal != 15 || counters.AllocTotal != 16 || counters.MailboxLen != 0 {
		t.Fatal(counters)
	}
}

func TestZigBackendCancellation(t *testing.T) {
	ready := make(chan struct{}, 4)
	var trace zigTrace
	g := talk.New().NewGroup(talk.GroupOptions{Trace: &trace, OnReady: func() { ready <- struct{}{} }})
	s, err := g.Load(talk.LoadOptions{Name: "s", Source: "on go\n return 1\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	id, p, err := s.Request(ctx, talk.Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	await := func() {
		t.Helper()
		select {
		case <-ready:
		case <-time.After(5 * time.Second):
			t.Fatal("missing OnReady")
		}
	}
	await()
	cancel()
	await()
	if len(trace) != 1 {
		t.Fatal("input traced before drain", trace)
	}
	result, err := g.Pump(time.Unix(1, 0), talk.PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.Done():
	default:
		t.Fatal("cancelled Request did not settle")
	}
	_, failure := p.Result()
	if failure == nil || failure.Code != "send failed" || failure.Data.Get("reason").String() != `"cancelled"` {
		t.Fatal(failure)
	}
	if len(trace) < 4 || !strings.HasPrefix(trace[1], "> request ") || trace[2] != "> cancel-delivery d1" || !strings.HasPrefix(trace[3], "> pump ") {
		t.Fatal(trace)
	}
	found := false
	for _, report := range result.Reports {
		if r, ok := report.(*talk.RunEnd); ok && r.Delivery == id {
			found = r.Outcome == talk.Cancelled
		}
	}
	if !found {
		t.Fatal(result)
	}
}

func TestZigBackendTerminalRequests(t *testing.T) {
	for _, scenario := range []struct {
		name, source, selector, reason string
		stop                           bool
	}{
		{"error", "on go\n return 1 / 0\nend go\n", "go", "errored", false},
		{"unhandled", "on go\nend go\n", "absent", "unhandled", false},
		{"passed", "on go\n pass go\nend go\n", "go", "unhandled", false},
		{"stopped", "on go\n return 1\nend go\n", "go", "stopped", true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			g := talk.New().NewGroup(talk.GroupOptions{})
			s, err := g.Load(talk.LoadOptions{Name: "s", Source: scenario.source})
			if err != nil {
				t.Fatal(err)
			}
			_, p, err := s.Request(context.Background(), talk.Message{Name: scenario.selector})
			if err != nil {
				t.Fatal(err)
			}
			if scenario.stop {
				s.Stop("done")
			}
			result, err := g.Pump(time.Unix(1, 0), talk.PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			select {
			case <-p.Done():
			default:
				t.Fatal("terminal Request did not settle", result)
			}
			_, failure := p.Result()
			if failure == nil || failure.Code != "send failed" || failure.Data.Get("reason").String() != `"`+scenario.reason+`"` {
				t.Fatal(failure)
			}
			if scenario.reason == "errored" {
				var end *talk.RunEnd
				for _, report := range result.Reports {
					if r, ok := report.(*talk.RunEnd); ok {
						end = r
					}
				}
				if end == nil || end.Error == nil || end.Error.Code != "division by zero" || end.At.Unit != "s" || end.At.Line != 2 || end.At.Col != 11 {
					t.Fatal(end)
				}
			}
		})
	}
}

func TestZigBackendOwnedDeepValuesAndIndependentGroups(t *testing.T) {
	// Above encoding/json's depth ceiling; the embedding model has no such cap.
	original := talk.Int(777)
	for i := 0; i < 10050; i++ {
		original = talk.List(original)
	}
	encoded, err := talk.EncodeValue(original)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	values := make(chan talk.Value, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			g := talk.New().NewGroup(talk.GroupOptions{Name: fmt.Sprint(i)})
			s, err := g.Load(talk.LoadOptions{Name: "s", Source: "on echo x\n return x\nend echo\n"})
			if err != nil {
				t.Error(err)
				return
			}
			_, p, err := s.Request(context.Background(), talk.Message{Name: "echo", Args: []talk.Value{original}})
			if err != nil {
				t.Error(err)
				return
			}
			if _, err = g.Pump(time.Unix(1, 0), talk.PumpOptions{}); err != nil {
				t.Error(err)
				return
			}
			select {
			case <-p.Done():
			default:
				t.Error("missing result")
				return
			}
			value, failure := p.Result()
			if failure != nil {
				t.Error(failure)
				return
			}
			// Later exports reuse guest reply storage and may grow memory.
			for j := 0; j < 16; j++ {
				if _, err = s.Deliver(talk.Message{Name: "echo", Args: []talk.Value{talk.Bytes(make([]byte, 32768))}}); err != nil {
					t.Error(err)
					return
				}
				if _, err = g.Pump(time.Unix(1, 0), talk.PumpOptions{}); err != nil {
					t.Error(err)
					return
				}
			}
			values <- value
		}(i)
	}
	wg.Wait()
	close(values)
	runtime.GC()
	n := 0
	for value := range values {
		n++
		got, err := talk.EncodeValue(value)
		if err != nil || !bytes.Equal(got, encoded) {
			t.Fatal("result changed after exports/collection", err)
		}
	}
	if n != 4 {
		t.Fatal("Groups did not all complete", n)
	}
}

func TestZigBackendRejectsUnsupportedOperations(t *testing.T) {
	core := talk.New()
	g := core.NewGroup(talk.GroupOptions{})
	s, err := g.Load(talk.LoadOptions{Name: "s", Source: "on go\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	checks := []struct {
		name string
		call func() error
	}{
		{"library", func() error {
			_, e := core.CompileLibrary(talk.LibrarySource{Name: "l", Source: "constant a = 1"}, nil, nil)
			return e
		}},
		{"registration", func() error { return g.AddLibrary(nil) }},
		{"replacement", func() error { _, e := g.ReplaceLibrary(nil, talk.ResetVariables); return e }},
		{"save", func() error { _, e := g.Save(); return e }},
		{"restore", func() error { _, _, e := core.Restore(nil, talk.RestoreOptions{}); return e }},
		{"reload", func() error { _, e := s.Reload("", talk.ResetVariables); return e }},
		{"extend", func() error { return s.Extend("") }},
		{"function", func() error { _, _, e := g.Call(context.Background(), talk.Nothing, nil, nil); return e }},
		{"decision", func() error { _, _, e := s.Decide(context.Background(), talk.Message{Name: "go"}); return e }},
		{"broadcast", func() error { _, e := g.Broadcast(talk.Message{Name: "go"}); return e }},
		{"object", func() error { _, e := g.Object(nil, "o", nil); return e }},
		{"parent", func() error { return g.SetParent(nil, nil) }},
		{"dispose", func() error { return g.Dispose(nil) }},
		{"grants", func() error {
			_, e := g.Load(talk.LoadOptions{Name: "other", Source: "", Grants: map[string]*talk.Grant{"api": nil}})
			return e
		}},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			err := check.call()
			if err == nil || !strings.HasPrefix(err.Error(), "experimental Zig backend:") {
				t.Fatal(err)
			}
		})
	}
	if g.Script("other") != nil {
		t.Fatal("unsupported load published a Script")
	}
}

func TestZigBackendDataValues(t *testing.T) {
	const encoded = `[null,true,-3,{"$dec":"3.0"},{"$dec":"9007199254740992"},"é<>\u000a",{"$quantity":["2.50","GBP"]},{"$bytes":"DQo="},{"$range":[3,7]},{"$date":"2026-09-27T14:30:00.5"},{"$instant":"1969-12-31T23:59:59.999999999Z"},{"$pattern":"<\"a\">"},{"$map":[["$ref",1],["é",[null,true]]]}]`
	value, err := talk.DecodeValue([]byte(encoded), nil)
	if err != nil {
		t.Fatal(err)
	}
	g := talk.New().NewGroup(talk.GroupOptions{})
	s, err := g.Load(talk.LoadOptions{Name: "s", Source: "on echo x\n return x\nend echo\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := s.Request(nil, talk.Message{Name: "echo", Args: []talk.Value{value}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = g.Pump(time.Unix(1, 0), talk.PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	got, failure := p.Result()
	if failure != nil {
		t.Fatal(failure)
	}
	actual, err := talk.EncodeValue(got)
	if err != nil || string(actual) != encoded {
		t.Fatal(string(actual), err)
	}
}

func TestZigBackendQueuedControls(t *testing.T) {
	for _, control := range []string{"cancel", "rewind", "stop"} {
		t.Run(control, func(t *testing.T) {
			g := talk.New().NewGroup(talk.GroupOptions{})
			s, err := g.Load(talk.LoadOptions{Name: "s", Source: "on go\n repeat forever\n end repeat\nend go\n"})
			if err != nil {
				t.Fatal(err)
			}
			_, p, err := s.Request(nil, talk.Message{Name: "go"})
			if err != nil {
				t.Fatal(err)
			}
			now := time.Unix(1, 0)
			if _, err = g.Pump(now, talk.PumpOptions{FuelSlice: 1}); err != nil {
				t.Fatal(err)
			}
			view := g.Inspect().Scripts[0]
			if len(view.Runs) != 1 {
				t.Fatal(view)
			}
			run := view.Runs[0].ID
			switch control {
			case "cancel":
				s.CancelRun(run)
			case "rewind":
				s.RewindRun(run)
			case "stop":
				s.Stop("done")
			}
			result, err := g.Pump(now, talk.PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if control == "rewind" {
				if result.State != talk.Rewound || s.Counters().MailboxLen != 1 {
					t.Fatal(result)
				}
				select {
				case <-p.Done():
					t.Fatal("rewound Request settled")
				default:
				}
				if _, err = g.Pump(now, talk.PumpOptions{FuelSlice: 1}); err != nil {
					t.Fatal(err)
				}
				s.Stop("after rewind")
				if _, err = g.Pump(now, talk.PumpOptions{}); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case <-p.Done():
			default:
				t.Fatal("controlled Request did not settle")
			}
			_, failure := p.Result()
			reason := "stopped"
			if control == "cancel" {
				reason = "cancelled"
			}
			if failure == nil || failure.Data.Get("reason").String() != `"`+reason+`"` {
				t.Fatal(failure)
			}
		})
	}
}
