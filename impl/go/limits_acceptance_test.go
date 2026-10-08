package northtalk

import (
	"fmt"
	"testing"
	"time"
)

func TestLimitFaultsNeverEnterCatchFinallyOrErrorHandler(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		limits     Limits
	}{
		{"fuel", "repeat forever\nend repeat", Limits{FuelPerRun: 50}},
		{"alloc", "put [1, 2, 3] into state", Limits{AllocPerRun: 8}},
		{"persistent", "put [1, 2, 3] into state\nwait 0 ms", Limits{PersistentState: 24}},
		{"depth", "recurse", Limits{CallDepth: 2}},
		{"pattern", "put \"abc\" into needle\nput <(needle)> into state", Limits{PatternSize: 2}},
		{"join", "wait for all\nask probe to later and wait\nask probe to later and wait\nend wait", Limits{MaxJoin: 1}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := New()
			entered := 0
			d, err := c.DefineCapability("probe",
				Operation{Name: "mark", Mode: Immediate, Result: NothingShape, Do: func(*Call, []Value) (Value, error) { entered++; return Nothing, nil }},
				Operation{Name: "later", Mode: Suspending, Result: NothingShape, Start: func(*Call, []Value) error { return nil }})
			if err != nil {
				t.Fatal(err)
			}
			g := c.NewGroup(GroupOptions{})
			source := fmt.Sprintf("script variable state = 0\non go\ntry\n%s\ncatch e\nask probe to mark\nfinally\nask probe to mark\nend try\nend go\non recurse\nrecurse\nend recurse\non error e\nask probe to mark\nend error\non ping\nreturn state\nend ping\n", tc.body)
			s, err := g.Load(LoadOptions{Name: "s", Source: source, Limits: tc.limits, Grants: map[string]*Grant{"probe": d.GrantAll(nil)}})
			if err != nil {
				t.Fatal(err)
			}
			_, p, err := s.Request(nil, Message{Name: "go"})
			if err != nil {
				t.Fatal(err)
			}
			r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
			if err != nil || len(operationalReports(r.Reports)) != 1 {
				t.Fatal(r, err)
			}
			end := operationalReports(r.Reports)[0].(*RunEnd)
			_, failed := p.Result()
			if end.Outcome != LimitFault || end.Limit != tc.name || end.Error != nil || failed == nil || failed.Data.Get("reason").String() != `"limit fault"` || entered != 0 {
				t.Fatal(end, failed, entered)
			}
			if !g.Inspect().Scripts[0].Vars[0].Val.Equal(Int(0)) || s.Counters().Faults != 1 {
				t.Fatal(g.Inspect(), s.Counters())
			}
			_, healthy, err := s.Request(nil, Message{Name: "ping"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
				t.Fatal(err)
			}
			v, failed := healthy.Result()
			if failed != nil || !v.Equal(Int(0)) || entered != 0 {
				t.Fatal(v, failed, entered)
			}
		})
	}
}

func TestRunawayScriptFaultPreservesOtherScriptsAndCommittedSegments(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	bad, err := g.Load(LoadOptions{Name: "runaway", Limits: Limits{FuelPerRun: 80}, Source: "script variable count = 0\non go\nput 1 into count\nwait 0 ms\nput 2 into count\nrepeat forever\nadd 1 to count\nend repeat\nend go\non ping\nadd 1 to count\nreturn count\nend ping\n"})
	if err != nil {
		t.Fatal(err)
	}
	good, err := g.Load(LoadOptions{Name: "healthy", Source: "script variable count = 0\non ping\nadd 1 to count\nreturn count\nend ping\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, runaway, err := bad.Request(nil, Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	_, first, err := good.Request(nil, Message{Name: "ping"})
	if err != nil {
		t.Fatal(err)
	}
	_, second, err := good.Request(nil, Message{Name: "ping"})
	if err != nil {
		t.Fatal(err)
	}
	faults := 0
	now := time.Unix(0, 0)
	for i := 0; i < 20; i++ {
		r, err := g.Pump(now, PumpOptions{FuelSlice: 20, FuelCap: 40})
		if err != nil {
			t.Fatal(err)
		}
		for _, report := range operationalReports(r.Reports) {
			if end, ok := report.(*RunEnd); ok && end.Outcome == LimitFault {
				faults++
				if end.Script != "runaway" || end.Limit != "fuel" {
					t.Fatal(end)
				}
			}
		}
		if r.State == Idle && r.NextDeadline.IsZero() {
			break
		}
	}
	for i, p := range []*Pending{first, second} {
		select {
		case <-p.Done():
		default:
			t.Fatal("healthy Script did not finish")
		}
		v, failed := p.Result()
		if failed != nil || !v.Equal(Int(int64(i+1))) {
			t.Fatal(v, failed)
		}
	}
	select {
	case <-runaway.Done():
	default:
		t.Fatal("runaway did not end")
	}
	_, failed := runaway.Result()
	if failed == nil || faults != 1 || bad.Counters().Faults != 1 || good.Counters().Faults != 0 {
		t.Fatal(failed, faults, bad.Counters(), good.Counters())
	}
	view := g.Inspect()
	if !view.Scripts[0].Vars[0].Val.Equal(Int(1)) || !view.Scripts[1].Vars[0].Val.Equal(Int(2)) {
		t.Fatal(view)
	}
	_, next, err := bad.Request(nil, Message{Name: "ping"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	v, failed := next.Result()
	if failed != nil || !v.Equal(Int(2)) {
		t.Fatal(v, failed)
	}
}
