package northtalk

import (
	"strings"
	"testing"
)

func TestScriptJoinResultAllocationFaultKeepsSettledReceivers(t *testing.T) {
	for _, tc := range []struct {
		name    string
		budget  int64
		outcome Outcome
	}{
		{"result does not fit", 159, LimitFault},
		{"result exactly fits", 160, Completed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var trace lines
			g := New().NewGroup(GroupOptions{Trace: &trace})
			a := joinLoad(t, g, "a", `on go
 wait for all
  send ping with 7 to b and wait
  send ping with 9 to c and wait
 end wait
 return it
end go`, Limits{AllocPerRun: tc.budget})
			joinLoad(t, g, "b", "on ping n\n return n\nend ping", Limits{})
			joinLoad(t, g, "c", "on ping n\n return n\nend ping", Limits{})
			a.Deliver(Message{Name: "go"})
			r := joinPump(t, g, 0, PumpOptions{})
			if len(r.Reports) != 3 || joinEnd(t, r, "b").Result.String() != "7" || joinEnd(t, r, "c").Result.String() != "9" || !r.NextDeadline.IsZero() {
				t.Fatal(r)
			}
			end := joinEnd(t, r, "a")
			if end.Outcome != tc.outcome {
				t.Fatal(end)
			}
			if tc.outcome == LimitFault {
				// Accepted messages cost 48 each; the failed 64-byte result adds no charge.
				if end.Limit != "alloc" || end.Alloc != 96 || end.At.PC != 9 || end.At.Line != 2 {
					t.Fatal(end)
				}
			} else if end.Alloc != 160 || end.Result.String() != "[7, 9]" {
				t.Fatal(end)
			}
			if records := strings.Join(trace, "\n"); strings.Contains(records, "abandon a/r1.") {
				t.Fatal(records)
			}
		})
	}
}

func TestScriptJoinFailureUnwindSpendsPumpCapBeforeCallerCatch(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	a := joinLoad(t, g, "a", `script variable caught = false
on go
 try
  query and wait
 catch e
  put true into caught
  return e
 end try
end go
on query
 wait for all
  send ping to b and wait
  send ping to c and wait
 end wait
end query`, Limits{})
	joinLoad(t, g, "b", "on ping\n wait 2 s\n return 7\nend ping", Limits{})
	joinLoad(t, g, "c", "on ping\n wait 0 s\n throw \"bad\"\nend ping", Limits{})
	a.Deliver(Message{Name: "go"})
	joinPump(t, g, 0, PumpOptions{})
	joinPump(t, g, 0, PumpOptions{FuelCap: 15})
	unwind := joinPump(t, g, 0, PumpOptions{FuelCap: 1})
	if len(unwind.Reports) != 0 || unwind.FuelUsed != 4 || unwind.State != Sliced || g.Inspect().Scripts[0].Vars[0].Val.String() != "false" {
		t.Fatal(unwind)
	}
	runs := g.Inspect().Scripts[0].Runs
	if len(runs) != 1 || runs[0].Status != Preempted {
		t.Fatal(runs)
	}
	end := joinEnd(t, joinPump(t, g, 0, PumpOptions{}), "a")
	if end.Outcome != Completed || end.Result.Get("code").String() != `"send failed"` || end.Result.Get("index").String() != "2" || end.Result.Get("at").Get("handler").String() != `"query"` || end.Result.Get("at").Get("line").String() != "11" || g.Inspect().Scripts[0].Vars[0].Val.String() != "true" {
		t.Fatal(end)
	}
	records := strings.Join(trace, "\n")
	if !strings.Contains(records, `raise a/r1 code="send failed" at=a:26 pos=11:2`) || strings.Count(records, "abandon a/r1.c1") != 1 {
		t.Fatal(records)
	}
	receiver := joinEnd(t, joinPump(t, g, 2, PumpOptions{}), "b")
	if receiver.Result.String() != "7" {
		t.Fatal(receiver)
	}
}

func TestScriptJoinBodyErrorAbandonsBeforeLaterUnwindFault(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	a := joinLoad(t, g, "a", "on go\n wait for all\n send ping to b and wait\n throw \"bad\"\n end wait\nend go", Limits{FuelPerRun: 47})
	joinLoad(t, g, "b", "on ping\n return 7\nend ping", Limits{})
	a.Deliver(Message{Name: "go"})
	end := joinEnd(t, joinPump(t, g, 0, PumpOptions{}), "a")
	if end.Outcome != LimitFault || end.Limit != "fuel" {
		t.Fatal(end)
	}
	records := strings.Join(trace, "\n")
	fault, abandon := strings.Index(records, "fault a/r1"), strings.Index(records, "abandon a/r1.c1")
	raised := strings.Index(records, `raise a/r1 code="bad"`)
	if raised < 0 || abandon < raised || fault < abandon {
		t.Fatal(records)
	}
}
