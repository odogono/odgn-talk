//go:build !talk_native_go

package northtalk

import (
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestZigBackendMidExportAdmission(t *testing.T) {
	core := New()
	var call *Call
	def, err := core.DefineCapability("api", Operation{Name: "read", Mode: Suspending, Result: NumberShape, Start: func(c *Call, _ []Value) error { call = c; return nil }})
	if err != nil {
		t.Fatal(err)
	}
	var ready atomic.Int64
	g := core.NewGroup(GroupOptions{OnReady: func() { ready.Add(1) }})
	load := func(name, source string, grants map[string]*Grant) *Script {
		s, e := g.Load(LoadOptions{Name: name, Source: source, Grants: grants, Limits: Limits{FuelPerRun: 100_000_000}})
		if e != nil {
			t.Fatal(e)
		}
		return s
	}
	waiting := load("waiting", "on go\n ask api to read and wait\n return it\nend go", map[string]*Grant{"api": def.GrantAll(nil)})
	_, answer, err := waiting.Request(nil, Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(0, 0)
	if _, err = g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if call == nil {
		t.Fatal("Start was not called")
	}
	busy := load("busy", "on go\n repeat forever\n end repeat\nend go", nil)
	target := load("target", "on echo x\n return x\nend echo", nil)
	victim := load("victim", "", nil)
	if _, err = busy.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	before := ready.Load()
	pumpDone := make(chan struct{})
	var pumpResult PumpResult
	var pumpErr error
	go func() { defer close(pumpDone); pumpResult, pumpErr = g.Pump(now, PumpOptions{FuelCap: 2_000_000}) }()
	backend := g.backend.(*zigGroup)
	deadline := time.Now().Add(10 * time.Second)
	for {
		backend.frameMu.Lock()
		active := backend.exporting && backend.exportMethod == "pump"
		backend.frameMu.Unlock()
		if active {
			break
		}
		select {
		case <-pumpDone:
			t.Fatal("long export ended before admission started")
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("Pump did not enter its export")
		}
		runtime.Gosched()
	}
	const workers = 32
	var wg sync.WaitGroup
	futures := make([]*Pending, workers)
	errors := make(chan error, workers)
	for i := range workers {
		wg.Go(func() {
			var e error
			switch i % 4 {
			case 0:
				_, futures[i], e = target.Request(nil, Message{Name: "echo", Args: []Value{Int(int64(i))}})
			case 1:
				victim.Stop("mid export")
			case 2:
				victim.CancelRun("victim/r999")
			case 3:
				if i == 3 {
					call.Answer(Int(5))
				} else {
					_, e = target.Deliver(Message{Name: "echo", Args: []Value{Int(int64(i))}})
				}
			}
			if e != nil {
				errors <- e
			}
		})
	}
	inputsDone := make(chan struct{})
	go func() { wg.Wait(); close(inputsDone) }()
	select {
	case <-inputsDone:
	case <-pumpDone:
		t.Fatal("admission waited for the non-yielding export to finish")
	case <-time.After(10 * time.Second):
		t.Fatal("concurrent admission deadlocked")
	}
	close(errors)
	for e := range errors {
		t.Error(e)
	}
	if got := ready.Load() - before; got != workers {
		t.Fatalf("OnReady notifications: got %d, want %d", got, workers)
	}
	for i, p := range futures {
		if p != nil {
			select {
			case <-p.Done():
				t.Errorf("input %d ran inside admitting Pump", i)
			default:
			}
		}
	}
	<-pumpDone
	if pumpErr != nil || pumpResult.State != Sliced {
		t.Fatal(pumpResult, pumpErr)
	}
	busy.Stop("finished")
	if _, err = g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	for i, p := range futures {
		if p == nil {
			continue
		}
		select {
		case <-p.Done():
		default:
			t.Fatalf("input %d did not run at the next drain", i)
		}
		v, e := p.Result()
		if e != nil || !v.Equal(Int(int64(i))) {
			t.Error(fmt.Sprint(i, v, e))
		}
	}
	select {
	case <-answer.Done():
	default:
		t.Fatal("mid-export Answer did not resume at next drain")
	}
	if v, e := answer.Result(); e != nil || !v.Equal(Int(5)) {
		t.Fatal(v, e)
	}
}
