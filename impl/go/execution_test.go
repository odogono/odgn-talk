package northtalk

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

type lines []string

func (l *lines) Record(s string) { *l = append(*l, s) }
func TestRequestExecutionAndWorkerRefusals(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Name: "test", Trace: &trace})
	s, e := g.Load(LoadOptions{Name: "math", Source: "script variable total\non sum a, b\n put a + b into total\n return total\nend sum\n"})
	if e != nil {
		t.Fatal(e)
	}
	id, p, e := s.Request(context.Background(), Message{Name: "sum", Args: []Value{Int(2), Int(3)}})
	if e != nil {
		t.Fatal(e)
	}
	if id != "d1" {
		t.Fatal(id)
	}
	now := time.Date(2026, 9, 30, 9, 0, 0, 0, time.UTC)
	result, e := g.Pump(now, PumpOptions{})
	if e != nil {
		t.Fatal(e)
	}
	select {
	case <-p.Done():
	default:
		t.Fatal("request still pending")
	}
	v, scriptError := p.Result()
	if scriptError != nil || !v.Equal(Int(5)) {
		t.Fatalf("%v %v", v, scriptError)
	}
	if result.FuelUsed != 15 || len(operationalReports(result.Reports)) != 1 {
		t.Fatalf("%+v", result)
	}
	if _, e = g.Pump(now.Add(-time.Second), PumpOptions{}); e == nil {
		t.Fatal("backwards Clock accepted")
	}
	inspection := g.Inspect()
	if !inspection.Scripts[0].Vars[0].Val.Equal(Int(5)) {
		t.Fatal(inspection)
	}
}
func TestFailedInitialiserHasItsInstructionPosition(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	_, e := g.Load(LoadOptions{Name: "bad", Source: "constant bad = 1 / 0\n"})
	rejected, ok := e.(*LoadError)
	if !ok || len(rejected.Diagnostics) != 1 {
		t.Fatalf("%v", e)
	}
	d := rejected.Diagnostics[0]
	if d.Code != "initialiser failed" || d.Line != 1 || d.Col != 18 {
		t.Fatal(d)
	}
	if g.Script("bad") != nil {
		t.Fatal("rejected Script registered")
	}
}
func TestMailboxReservationIncludesQueuedInputs(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, e := g.Load(LoadOptions{Name: "test", Source: "on go\nend go\n", Limits: Limits{MailboxDepth: 1}})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Deliver(Message{Name: "go"}); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Deliver(Message{Name: "go"}); e != ErrMailboxFull {
		t.Fatalf("%v", e)
	}
	if _, e = g.Pump(time.Now(), PumpOptions{}); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Deliver(Message{Name: "go"}); e != nil {
		t.Fatal(e)
	}
}

func TestTraceInputsDrainInOrderAndPendingCancellation(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	s, e := g.Load(LoadOptions{Name: "s", Source: "on go\n return 1\nend go\n"})
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	id, p, e := s.Request(ctx, Message{Name: "go"})
	if e != nil {
		t.Fatal(e)
	}
	if len(trace) != 1 {
		t.Fatal("queued input traced before Pump", trace)
	}
	cancel()
	// Cancellation is an input, so wait for OnReady-independent queue capture.
	for j := 0; j < 1000; j++ {
		g.mu.Lock()
		n := len(g.inputs)
		g.mu.Unlock()
		if n == 2 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	result, e := g.Pump(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), PumpOptions{})
	if e != nil {
		t.Fatal(e)
	}
	<-p.Done()
	_, se := p.Result()
	if se == nil || se.Code != "send failed" || se.Data.Get("reason").String() != `"cancelled"` {
		t.Fatal(se)
	}
	if len(operationalReports(result.Reports)) != 1 || operationalReports(result.Reports)[0].(*RunEnd).Delivery != id || operationalReports(result.Reports)[0].(*RunEnd).Outcome != Cancelled {
		t.Fatal(result)
	}
	if trace[1][:9] != "> request" || trace[2] != "> cancel-delivery d1" || trace[3][:6] != "> pump" {
		t.Fatal(trace)
	}
}

func TestWorkerReentryFromTraceDoesNotDeadlock(t *testing.T) {
	var g *Group
	var reentry error
	sink := traceFunc(func(line string) {
		if strings.HasPrefix(line, "> pump") && reentry == nil {
			_, reentry = g.Pump(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), PumpOptions{})
		}
	})
	g = New().NewGroup(GroupOptions{Trace: sink})
	if _, e := g.Pump(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), PumpOptions{}); e != nil {
		t.Fatal(e)
	}
	if e, ok := reentry.(*HostError); !ok || e.Code != ReentrantCall {
		t.Fatal(reentry)
	}
}

type traceFunc func(string)

func (f traceFunc) Record(s string) { f(s) }

func TestRefusedInputsAreTracedWithoutDeliveryIDs(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	s, e := g.Load(LoadOptions{Name: "s", Source: "on go\nend go\n", Limits: Limits{MailboxDepth: 1}})
	if e != nil {
		t.Fatal(e)
	}
	s.Deliver(Message{Name: "go"})
	if _, e = s.Deliver(Message{Name: "go"}); e != ErrMailboxFull {
		t.Fatal(e)
	}
	if len(trace) != 3 || trace[1] != "> deliver to=s message=go" || trace[2] != `refused code="mailbox full"` {
		t.Fatal(trace)
	}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	g.Pump(now, PumpOptions{})
	g.Pump(now.Add(-time.Second), PumpOptions{})
	if trace[len(trace)-1] != `refused code="clock backwards"` || !strings.HasPrefix(trace[len(trace)-2], "> pump clock=") {
		t.Fatal(trace)
	}
}
func TestTracePreservesScriptMessagesAndOmitsCoreMessages(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	s, e := g.Load(LoadOptions{Name: "s", Source: "script variable caught\non go\n try\n  put 1 / 0 into caught\n catch e\n  put e into caught\n end try\n throw {code: \"mine\", message: \"keep me\"}\nend go\n"})
	if e != nil {
		t.Fatal(e)
	}
	s.Deliver(Message{Name: "go"})
	g.Pump(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), PumpOptions{})
	g.Inspect()
	all := strings.Join(trace, "\n")
	if !strings.Contains(all, `message: "keep me"`) || strings.Contains(all, "Can't divide by zero") {
		t.Fatal(all)
	}
}
func TestSliceDebtAndPumpRoundRobin(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	var scripts []*Script
	for _, name := range []string{"a", "b"} {
		s, e := g.Load(LoadOptions{Name: name, Source: "on go\n return 2 + 3\nend go\n"})
		if e != nil {
			t.Fatal(e)
		}
		scripts = append(scripts, s)
		s.Deliver(Message{Name: "go"})
		s.Deliver(Message{Name: "go"})
	}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	first, e := g.Pump(now, PumpOptions{FuelSlice: 1})
	if e != nil || first.FuelUsed != 10 || first.State != Sliced {
		t.Fatal(first, e)
	}
	second, _ := g.Pump(now, PumpOptions{FuelSlice: 1})
	if second.FuelUsed != 0 {
		t.Fatal("debt not carried", second)
	}
	for j := 0; j < 4; j++ {
		g.Pump(now, PumpOptions{FuelSlice: 1})
	}
	g.Pump(now, PumpOptions{})
	var finished []string
	for _, line := range trace {
		if strings.HasPrefix(line, "run ") {
			finished = append(finished, strings.Fields(line)[1])
		}
	}
	if strings.Join(finished, ",") != "a/r1,b/r1,a/r2,b/r2" {
		t.Fatal(finished)
	}
}

func TestCancellationCleanupAndNestedFaultLocation(t *testing.T) {
	var trace lines
	g := New().NewGroup(GroupOptions{Trace: &trace})
	s, e := g.Load(LoadOptions{Name: "s", Limits: Limits{CleanupBudget: 1}, Source: "script variable x = 0\non go\n try\n  put 1 into x\n  repeat forever\n  end repeat\n finally\n  put 2 + 3 into x\n end try\nend go\nfunction makeList\n return [1,2,3]\nend makeList\non allocate\n return makeList()\nend allocate\n"})
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	_, p, e := s.Request(ctx, Message{Name: "go"})
	if e != nil {
		t.Fatal(e)
	}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	g.Pump(now, PumpOptions{FuelSlice: 10})
	cancel()
	for j := 0; j < 1000; j++ {
		g.mu.Lock()
		n := len(g.inputs)
		g.mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	result, e := g.Pump(now, PumpOptions{})
	if e != nil {
		t.Fatal(e)
	}
	<-p.Done()
	r := operationalReports(result.Reports)[0].(*RunEnd)
	if r.Outcome != Cancelled || r.CleanupFailed == nil || r.CleanupFailed.Limit != "cleanup" || r.Limit != "" || r.Error != nil {
		t.Fatalf("%+v", r)
	}
	if !g.Inspect().Scripts[0].Vars[0].Val.Equal(Int(0)) {
		t.Fatal("cleanup limit failed to restore its base")
	}
	if !strings.Contains(strings.Join(trace, "\n"), "cleanup-failed s/r1 limit=cleanup\nseg") {
		t.Fatal(trace)
	}
	s.Deliver(Message{Name: "allocate", Limits: &LimitOverride{AllocPerRun: 1}})
	result, e = g.Pump(now, PumpOptions{})
	if e != nil {
		t.Fatal(e)
	}
	r = operationalReports(result.Reports)[0].(*RunEnd)
	if r.Outcome != LimitFault || r.At.Handler != "makeList" {
		t.Fatalf("%+v", r)
	}
}

func TestConcurrentDeliveryReservationsAndFunctionOwnership(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, e := g.Load(LoadOptions{Name: "s", Source: "on go\n return given x: x\nend go\non use f\n return f(7)\nend use\n"})
	if e != nil {
		t.Fatal(e)
	}
	_, p, e := s.Request(nil, Message{Name: "go"})
	if e != nil || p == nil {
		t.Fatal(p, e)
	}
	g.Pump(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), PumpOptions{})
	fn, se := p.Result()
	if se != nil {
		t.Fatal(se)
	}
	other := New().NewGroup(GroupOptions{})
	os, e := other.Load(LoadOptions{Name: "other", Source: "on use f\nend use\n"})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = os.Deliver(Message{Name: "use", Args: []Value{List(fn)}}); e == nil || e.(*HostError).Code != WrongGroup {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	wg.Add(4)
	for j := 0; j < 4; j++ {
		go func() {
			defer wg.Done()
			for k := 0; k < 25; k++ {
				if _, e := s.Deliver(Message{Name: "use", Args: []Value{fn}}); e != nil {
					t.Error(e)
				}
			}
		}()
	}
	for j := 0; j < 20; j++ {
		g.Pump(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), PumpOptions{FuelCap: 100})
	}
	wg.Wait()
	for j := 0; j < 100; j++ {
		r, e := g.Pump(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), PumpOptions{})
		if e != nil {
			t.Fatal(e)
		}
		if r.State == Idle {
			break
		}
	}
	if c := s.Counters(); c.Runs != 101 || c.MailboxLen != 0 {
		t.Fatal(c)
	}
}

func TestInitialiserFunctionBelongsToItsGroup(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, e := g.Load(LoadOptions{Name: "s", Source: "constant identity = given x: x\nscript variable fn = identity\non use f\n return f(9)\nend use\n"})
	if e != nil {
		t.Fatal(e)
	}
	fn := g.Inspect().Scripts[0].Vars[0].Val
	_, p, e := s.Request(context.Background(), Message{Name: "use", Args: []Value{fn}})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = g.Pump(time.Now(), PumpOptions{}); e != nil {
		t.Fatal(e)
	}
	if v, e := p.Result(); e != nil || !v.Equal(Int(9)) {
		t.Fatalf("%v %v", v, e)
	}
}

func TestLoadRejectsUnavailableHostBindings(t *testing.T) {
	for _, o := range []LoadOptions{
		{Name: "s", Source: "on go\nend go\n", Grants: map[string]*Grant{"host": {}}},
		{Name: "s", Source: "on go\nend go\n", Owner: &Object{}},
		{Name: "s", Source: "on go\nend go\n", Objects: map[string]*Object{"host": {}}},
	} {
		g := New().NewGroup(GroupOptions{})
		if _, e := g.Load(o); e == nil {
			t.Fatal("accepted unavailable Host binding")
		}
		if g.Script("s") != nil {
			t.Fatal("failed Load registered Script")
		}
	}
}
