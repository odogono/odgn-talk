package northtalk

import (
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
	"strings"
	"testing"
	"time"
)

func TestUncaughtErrorQueuesASeparateRunBehindExistingMessages(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	s, err := g.Load(LoadOptions{Name: "s", Source: `script variable seen = []
on fail x
 put "failed" after seen
 throw {code: "mine", message: "keep me", value: x}
end fail
on next
 put "next" after seen
end next
on error "other"
 put "wrong" after seen
end error
on error "mine"
 put "error" after seen
end error
`})
	if err != nil {
		t.Fatal(err)
	}
	id, pending, err := s.Request(nil, Message{Name: "fail", Args: []Value{Int(7)}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Deliver(Message{Name: "next"}); err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Reports) != 3 {
		t.Fatalf("want failed, next and error Runs: %+v", result)
	}
	for j, handler := range []string{"fail", "next", "error"} {
		report := result.Reports[j].(*RunEnd)
		if report.Handler != handler || report.Run != RunID([]string{"s/r1", "s/r2", "s/r3"}[j]) {
			t.Fatalf("%+v", report)
		}
	}
	failed := result.Reports[0].(*RunEnd)
	handled := result.Reports[2].(*RunEnd)
	if failed.Outcome != Errored || failed.Delivery != id || handled.Outcome != Completed || handled.Delivery != "" {
		t.Fatalf("%+v %+v", failed, handled)
	}
	select {
	case <-pending.Done():
	default:
		t.Fatal("Request not settled")
	}
	_, se := pending.Result()
	if se == nil || se.Code != "send failed" || !se.Data.Get("reason").Equal(mustValue(t, `"errored"`)) || se.Data.Get("error").Get("message").String() != `"keep me"` {
		t.Fatal(se)
	}
	if got := g.Inspect().Scripts[0].Vars[0].Val.String(); got != `["failed", "next", "error"]` {
		t.Fatal(got)
	}
	if !strings.Contains(strings.Join(trace, "\n"), "seg s/r3 start from=s/r1 handler=error clause=2") {
		t.Fatal(trace)
	}
	if c := s.Counters(); c.Runs != 3 || c.MailboxLen != 0 || c.FuelTotal != result.FuelUsed {
		t.Fatal(c)
	}
}

func TestErrorDuringBindingIsAvailableToGuardsAndLaterClauses(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: `script variable caught
on fail x
 throw "mine"
end fail
on error "mine" where the name of msg = "other", during msg
 put "wrong" into caught
end error
on error e where the name of msg = "fail", during msg
 put [the code of e, msg] into caught
end error
`})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Deliver(Message{Name: "fail", Args: []Value{Int(7)}}); err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(result.Reports) != 2 {
		t.Fatal(result, err)
	}
	if got := g.Inspect().Scripts[0].Vars[0].Val.String(); got != `["mine", {name: "fail", args: [7]}]` {
		t.Fatal(got)
	}
}

func TestErrorMessagesDoNotChainOrReportInternalUnhandled(t *testing.T) {
	for _, tc := range []struct {
		name, handlers string
		runs           int
		outcome        Outcome
	}{
		{"absent", "", 1, Errored},
		{"unmatched", "on error \"other\"\n return\nend error\n", 2, UnhandledOutcome},
		{"recursive", "on error e\n throw \"second\"\nend error\n", 2, Errored},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var trace lines
			g := New().NewGroup(GroupOptions{Trace: &trace})
			s, err := g.Load(LoadOptions{Name: "s", Source: "on fail\n throw \"first\"\nend fail\n" + tc.handlers})
			if err != nil {
				t.Fatal(err)
			}
			s.Deliver(Message{Name: "fail"})
			result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
			if err != nil || result.State != Idle || len(result.Reports) != tc.runs {
				t.Fatal(result, err)
			}
			if r := result.Reports[tc.runs-1].(*RunEnd); r.Outcome != tc.outcome {
				t.Fatalf("%+v", r)
			}
			if strings.Contains(strings.Join(trace, "\n"), "\nunhandled ") {
				t.Fatal(trace)
			}
			// A Host-delivered error still gets the ordinary unhandled report when
			// unmatched, and its failure never starts another error Run.
			_, p, err := s.Request(nil, Message{Name: "error", Args: []Value{mustValue(t, `{code: "host"}`)}})
			if err != nil {
				t.Fatal(err)
			}
			result, err = g.Pump(time.Unix(0, 0), PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			expected := 2
			if tc.name == "recursive" {
				expected = 1
			}
			if len(result.Reports) != expected {
				t.Fatal(result)
			}
			select {
			case <-p.Done():
			default:
				t.Fatal("Host error Request not settled")
			}
		})
	}
}

func TestFullMailboxDropsErrorWithoutReservingCapacity(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	s, err := g.Load(LoadOptions{Name: "s", Limits: Limits{MailboxDepth: 1}, Source: `on fail
 throw "first"
end fail
on next
end next
on error e
 throw "second"
end error
`})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "fail"})
	// This any-goroutine input is accepted during the Pump, before the error
	// message is queued. Reserved input capacity counts toward mailbox depth.
	var deliveryError error
	g.options.Trace = traceFunc(func(line string) {
		trace.Record(line)
		if strings.HasPrefix(line, "run s/r1 ") {
			_, deliveryError = s.Deliver(Message{Name: "next"})
		}
	})
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || deliveryError != nil || len(result.Reports) != 1 {
		t.Fatal(result, err, deliveryError)
	}
	if !strings.Contains(strings.Join(trace, "\n"), "note s/r1 kind=error-dropped") {
		t.Fatal(trace)
	}
	result, err = g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(result.Reports) != 1 || result.Reports[0].(*RunEnd).Handler != "next" {
		t.Fatal(result, err)
	}
	if _, err = s.Deliver(Message{Name: "next"}); err != nil {
		t.Fatal("leaked reservation", err)
	}
}

func TestInternalErrorRetainsMailboxStateAndDispatchesAfterPreemption(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on fail\n throw \"mine\"\nend fail\non error e\n return e\nend error\n"})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "fail"})
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{FuelCap: 19})
	if err != nil || len(result.Reports) != 1 || result.State != Sliced {
		t.Fatal(result, err)
	}
	inspection := g.Inspect().Scripts[0]
	if len(inspection.Mailbox) != 1 || inspection.Mailbox[0].Message.Name != "error" || inspection.Mailbox[0].From != "s/r1" || inspection.Mailbox[0].Delivery != "" {
		t.Fatal(inspection)
	}
	// Message size is 32 plus the retained error argument; during is metadata.
	if c := s.Counters(); c.PersistentState != 324 || c.MailboxLen != 1 {
		t.Fatal(c)
	}
	result, err = g.Pump(time.Unix(0, 0), PumpOptions{FuelSlice: 1})
	if err != nil || result.FuelUsed != 5 || result.State != Sliced {
		t.Fatal(result, err)
	}
	result, err = g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(result.Reports) != 1 || result.Reports[0].(*RunEnd).Outcome != Completed {
		t.Fatal(result, err)
	}
	if !strings.Contains(strings.Join(trace, "\n"), "preempt s/r2 start from=s/r1 handler=error clause=1 by=slice fuel=5 alloc=0") {
		t.Fatal(trace)
	}
	if c := s.Counters(); c.PersistentState != 0 || c.MailboxLen != 0 || c.Runs != 2 {
		t.Fatal(c)
	}
}

func TestGuardFailuresDoNotDeliverErrors(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	s, err := g.Load(LoadOptions{Name: "s", Source: `script variable caught = false
on go x where 1 / x > 0
 return "positive"
end go
on go x where x
 return "boolean"
end go
on go x
 return "fallback"
end go
on error e
 put true into caught
end error
`})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := s.Request(nil, Message{Name: "go", Args: []Value{Int(0)}})
	if err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(result.Reports) != 1 {
		t.Fatal(result, err)
	}
	if v, se := p.Result(); se != nil || v.String() != `"fallback"` {
		t.Fatal(v, se)
	}
	if !g.Inspect().Scripts[0].Vars[0].Val.Equal(Bool(false)) {
		t.Fatal("Guard delivered error")
	}
	all := strings.Join(trace, "\n")
	if !strings.Contains(all, `code="division by zero"`) || !strings.Contains(all, "value=0") || !strings.Contains(all, "handler=go clause=3") {
		t.Fatal(all)
	}
}

func mustValue(t *testing.T, display string) Value {
	t.Helper()
	reader := corevalue.Reader{Text: display}
	v, err := reader.Value()
	if err != nil {
		t.Fatal(err)
	}
	return Value{v}
}

func TestUnknownMessageHasNoHandlerInRunReportOrTrace(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on known x\nend known\n"})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "unknown"})
	s.Deliver(Message{Name: "known"}) // wrong arity, but this Handler exists
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(result.Reports) != 4 {
		t.Fatal(result, err)
	}
	if r := result.Reports[0].(*RunEnd); r.Handler != "" || r.Outcome != UnhandledOutcome || r.Fuel != 0 {
		t.Fatalf("%+v", r)
	}
	if r := result.Reports[2].(*RunEnd); r.Handler != "known" || r.Outcome != UnhandledOutcome {
		t.Fatalf("%+v", r)
	}
	if strings.Contains(strings.Join(trace, "\n"), "handler=unknown") {
		t.Fatal(trace)
	}
}

func TestErrorDuringSurvivesLocalCallsAndClosureCapture(t *testing.T) {
	for _, internal := range []bool{false, true} {
		t.Run(map[bool]string{false: "Host", true: "internal"}[internal], func(t *testing.T) {
			g := New().NewGroup(GroupOptions{})
			s, err := g.Load(LoadOptions{Name: "s", Source: `script variable fn
script variable caught
on fail
  throw "mine"
end fail
on error "mine", during msg
  put given: msg into fn
  error {code: "local"}
end error
on error "local", during msg
  put [msg, fn()] into caught
end error
`})
			if err != nil {
				t.Fatal(err)
			}
			message := Message{Name: "error", Args: []Value{mustValue(t, `{code: "mine"}`)}}
			expected := `[nothing, nothing]`
			runs := 1
			if internal {
				message = Message{Name: "fail"}
				expected = `[{name: "fail", args: []}, {name: "fail", args: []}]`
				runs = 2
			}
			if _, err = s.Deliver(message); err != nil {
				t.Fatal(err)
			}
			result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
			if err != nil || len(result.Reports) != runs || result.Reports[runs-1].(*RunEnd).Outcome != Completed {
				t.Fatal(result, err)
			}
			if got := g.Inspect().Scripts[0].Vars[1].Val.String(); got != expected {
				t.Fatal(got)
			}
		})
	}
}
