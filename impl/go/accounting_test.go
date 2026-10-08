package northtalk

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"
)

// Existing behavior tests select operational reports; accounting is asserted
// separately below, against the unfiltered public stream.
func operationalReports(reports []Report) []Report {
	var out []Report
	for _, r := range reports {
		switch r.(type) {
		case *RunStarted, *RunDiscarded, *RunAccounting, *CausalWork:
		default:
			out = append(out, r)
		}
	}
	return out
}

func TestAccountingTerminal(t *testing.T) {
	g := New().NewGroup(GroupOptions{Name: "g"})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n return 3\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(time.Time{}, PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Reports) != 4 {
		t.Fatal(result.Reports)
	}
	start := result.Reports[0].(*RunStarted)
	end := result.Reports[1].(*RunEnd)
	fuel := result.Reports[2].(*RunAccounting)
	causal := result.Reports[3].(*CausalWork)
	if start.Run != "s/r1" || start.RootDelivery != "d1" || start.Selector != "go" || fuel.Fuel != end.Fuel || fuel.State != "terminal" || causal.LiveRuns != 0 || causal.QueuedMessages != 0 {
		t.Fatalf("%+v %+v %+v", start, fuel, causal)
	}
	next, err := g.Pump(time.Time{}, PumpOptions{})
	if err != nil || len(next.Reports) != 0 {
		t.Fatal(next, err)
	}
}

func TestAccountingObservation(t *testing.T) {
	g := New().NewGroup(GroupOptions{Name: "g"})
	s := joinLoad(t, g, "s", "on watch\n wait for\n when ping n where n > 0 then\n return n\n end wait\nend watch\non ping n\nend ping", Limits{})
	s.Deliver(Message{Name: "watch"})
	first := joinPump(t, g, 0, PumpOptions{})
	before := first.Reports[len(first.Reports)-2].(*RunAccounting).Fuel
	s.Deliver(Message{Name: "ping", Args: []Value{Int(-1)}})
	next := joinPump(t, g, 0, PumpOptions{FuelCap: 1})
	var rows []*RunAccounting
	for _, r := range next.Reports {
		if a, ok := r.(*RunAccounting); ok {
			rows = append(rows, a)
		}
	}
	if len(rows) != 2 || rows[0].Run != "s/r1" || rows[0].RootDelivery != "d1" || rows[0].Fuel != before+7 || rows[1].RootDelivery != "d2" || rows[1].Fuel != 0 {
		t.Fatalf("%+v", rows)
	}
}

func TestAccountingQueuedDescendant(t *testing.T) {
	g := New().NewGroup(GroupOptions{Name: "g"})
	s := joinLoad(t, g, "s", "on go\n send child to s\nend go\non child\n return 2\nend child", Limits{})
	s.Deliver(Message{Name: "go"})
	var result PumpResult
	for range 50 {
		result = joinPump(t, g, 0, PumpOptions{FuelCap: 1})
		ended := false
		for _, r := range result.Reports {
			if _, ok := r.(*RunEnd); ok {
				ended = true
			}
		}
		if ended {
			break
		}
	}
	pending := result.Reports[len(result.Reports)-1].(*CausalWork)
	if pending.LiveRuns != 0 || pending.QueuedMessages != 1 || pending.RootDelivery != "d1" {
		t.Fatal(pending)
	}
	saved, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	copy, baseline, err := New().Restore(saved, RestoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(baseline.Reports) != 1 || *baseline.Reports[0].(*CausalWork) != *pending {
		t.Fatal(baseline)
	}
	next := joinPump(t, copy, 0, PumpOptions{})
	start := next.Reports[0].(*RunStarted)
	if start.RootDelivery != "d1" || start.ParentRun != "s/r1" || start.Run != "s/r2" {
		t.Fatal(start)
	}
	reports, err := s.Reload("on go\nend go", CarryVariables)
	if err != nil {
		t.Fatal(err)
	}
	final := reports[len(reports)-1].(*CausalWork)
	if final.RootDelivery != "d1" || final.LiveRuns != 0 || final.QueuedMessages != 0 || final.DiscardedMessages != 1 {
		t.Fatal(final)
	}
}

func TestAccountingDetachedRestoreDiscard(t *testing.T) {
	g := New().NewGroup(GroupOptions{Name: "g"})
	s := joinLoad(t, g, "s", "on go\n send child to s\nend go\non child\n wait 1 s\nend child", Limits{})
	s.Deliver(Message{Name: "go"})
	first := joinPump(t, g, 0, PumpOptions{})
	var child *RunAccounting
	for _, r := range first.Reports {
		if a, ok := r.(*RunAccounting); ok && a.Run == "s/r2" {
			child = a
		}
	}
	if child == nil || child.RootDelivery != "d1" || child.ParentRun != "s/r1" {
		t.Fatal(child)
	}
	saved, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	copy, baseline, err := New().Restore(saved, RestoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(baseline.Reports) != 2 || *baseline.Reports[0].(*RunAccounting) != *child {
		t.Fatal(baseline)
	}
	reports, err := copy.Script("s").Reload("on go\nend go", CarryVariables)
	if err != nil {
		t.Fatal(err)
	}
	discard := reports[0].(*RunDiscarded)
	if discard.Run != "s/r2" || discard.Reason != "reload" {
		t.Fatal(discard)
	}
	total := reports[len(reports)-2].(*RunAccounting)
	if total.Fuel != child.Fuel || total.State != "discarded" {
		t.Fatal(total)
	}
}

func TestAccountingVariablesOnly(t *testing.T) {
	g := New().NewGroup(GroupOptions{Name: "g"})
	s := joinLoad(t, g, "s", "on go\n wait 1 s\nend go", Limits{})
	s.Deliver(Message{Name: "go"})
	first := joinPump(t, g, 0, PumpOptions{})
	fuel := first.Reports[len(first.Reports)-2].(*RunAccounting).Fuel
	s.Deliver(Message{Name: "go"})
	saved, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	saved = rewriteSave(t, saved, func(data map[string]any) { data["Versions"].(map[string]any)["CostModel"] = "old" })
	_, rejected, err := New().Restore(saved, RestoreOptions{})
	if err == nil || len(rejected.Reports) != 0 {
		t.Fatal(rejected, err)
	}
	copy, result, err := New().Restore(saved, RestoreOptions{Mismatch: VariablesOnly})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Reports) != 4 {
		t.Fatal(result.Reports)
	}
	discard := result.Reports[0].(*RunDiscarded)
	total := result.Reports[1].(*RunAccounting)
	queued := result.Reports[3].(*CausalWork)
	if discard.Reason != "variables-only restore" || total.State != "discarded" || total.Fuel != fuel || queued.RootDelivery != "d2" || queued.DiscardedMessages != 1 || queued.QueuedMessages != 0 {
		t.Fatal(discard, total, queued)
	}
	if len(joinPump(t, copy, 0, PumpOptions{}).Reports) != 0 {
		t.Fatal("restored discarded work ran")
	}
}

func TestAccountingQueuedCancellation(t *testing.T) {
	ready := make(chan struct{}, 4)
	g := New().NewGroup(GroupOptions{Name: "g", OnReady: func() { ready <- struct{}{} }})
	s := joinLoad(t, g, "s", "on go\nend go", Limits{})
	ctx, cancel := context.WithCancel(context.Background())
	_, _, err := s.Request(ctx, Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	<-ready
	cancel()
	<-ready
	reports := joinPump(t, g, 0, PumpOptions{}).Reports
	if len(reports) != 2 {
		t.Fatal(reports)
	}
	causal := reports[1].(*CausalWork)
	if causal.RootDelivery != "d1" || causal.LiveRuns != 0 || causal.QueuedMessages != 0 || causal.DiscardedMessages != 0 {
		t.Fatal(causal)
	}
}

// These fixtures are also consumed by the TS tests. They compare public API
// records independently of canonical Trace replay.
func TestAccountingSharedReports(t *testing.T) {
	data, err := os.ReadFile("../testdata/run-accounting.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Source string
		Pumps        []int64
		Expected     []any
	}
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			g := New().NewGroup(GroupOptions{Name: "g"})
			s := joinLoad(t, g, "s", c.Source, Limits{})
			s.Deliver(Message{Name: "go"})
			for i, clock := range c.Pumps {
				result, err := g.Pump(time.Unix(0, clock), PumpOptions{})
				if err != nil {
					t.Fatal(err)
				}
				got := []any{}
				for _, r := range result.Reports {
					row := map[string]any{}
					ancestry := func(a RunAncestry) {
						row["rootDelivery"] = a.RootDelivery
						if a.ParentRun != "" {
							row["parentRun"] = a.ParentRun
						}
						if a.ParentCall != "" {
							row["parentCall"] = a.ParentCall
						}
					}
					switch r := r.(type) {
					case *RunStarted:
						ancestry(r.RunAncestry)
						row["kind"] = "run started"
						row["script"] = r.Script
						row["run"] = r.Run
						row["selector"] = r.Selector
						if r.Delivery != "" {
							row["delivery"] = r.Delivery
						}
						args := []string{}
						for _, v := range r.Args {
							args = append(args, v.String())
						}
						row["args"] = args
					case *RunEnd:
						row["kind"] = "run end"
						row["run"] = r.Run
					case *RunAccounting:
						ancestry(r.RunAncestry)
						row["kind"] = "run accounting"
						row["script"] = r.Script
						row["run"] = r.Run
						row["fuel"] = r.Fuel
						row["state"] = r.State
					case *CausalWork:
						row["kind"] = "causal work"
						row["rootDelivery"] = r.RootDelivery
						row["liveRuns"] = r.LiveRuns
						row["queuedMessages"] = r.QueuedMessages
						row["discardedMessages"] = r.DiscardedMessages
					default:
						t.Fatalf("unexpected report %T", r)
					}
					got = append(got, row)
				}
				actual, _ := json.Marshal(got)
				expected, _ := json.Marshal(c.Expected[i])
				if !bytes.Equal(actual, expected) {
					t.Fatalf("Pump %d\ngot %s\nwant %s", i, actual, expected)
				}
			}
		})
	}
}

func TestAccountingLibraryReplacement(t *testing.T) {
	core := New()
	g := core.NewGroup(GroupOptions{Name: "g"})
	library, err := core.CompileLibrary(LibrarySource{Name: "lib", Source: "function foo\n return 1\nend foo"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = g.AddLibrary(library); err != nil {
		t.Fatal(err)
	}
	s := joinLoad(t, g, "s", "use foo from lib\non go\n wait 1 s\n return foo()\nend go", Limits{})
	s.Deliver(Message{Name: "go"})
	first := joinPump(t, g, 0, PumpOptions{})
	fuel := first.Reports[len(first.Reports)-2].(*RunAccounting).Fuel
	replacement, err := core.CompileLibrary(LibrarySource{Name: "lib", Source: "function foo\n return 2\nend foo"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	reports, err := g.ReplaceLibrary(replacement, CarryVariables)
	if err != nil {
		t.Fatal(err)
	}
	if len(reports) != 4 {
		t.Fatal(reports)
	}
	if r := reports[0].(*RunDiscarded); r.Reason != "library replacement" || r.Run != "s/r1" {
		t.Fatal(r)
	}
	if r := reports[2].(*RunAccounting); r.State != "discarded" || r.Fuel != fuel {
		t.Fatal(r)
	}
}
