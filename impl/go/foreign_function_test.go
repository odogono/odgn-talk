package northtalk

import (
	"context"
	"testing"
	"time"
)

func TestForeignFunctionCallRunsInHomeAndWaitsForReply(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	home, err := g.Load(LoadOptions{Name: "home", Source: "script variable total = 0\non make\n put 3 into offset\n return given n\n  wait 1s\n  put n + offset into total\n  return total\n end given\nend make"})
	if err != nil {
		t.Fatal(err)
	}
	caller, err := g.Load(LoadOptions{Name: "caller", Source: "on go callback\n callback(7) and wait\n return it\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(0, 0)
	_, made, err := home.Request(context.Background(), Message{Name: "make"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	fn, failure := made.Result()
	if failure != nil {
		t.Fatal(failure)
	}
	_, p, err := caller.Request(context.Background(), Message{Name: "go", Args: []Value{fn}})
	if err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(now, PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if home.Counters().Runs != 2 || caller.Counters().Runs != 1 || !result.NextDeadline.Equal(now.Add(time.Second)) {
		t.Fatal(home.Counters(), caller.Counters(), result)
	}
	select {
	case <-p.Done():
		t.Fatal("call settled before receiver")
	default:
	}
	if _, err := g.Pump(now.Add(time.Second), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.Done():
	default:
		t.Fatal("foreign reply did not settle")
	}
	answer, failure := p.Result()
	if failure != nil || !answer.Equal(Int(10)) {
		t.Fatal(answer, failure)
	}
	if !g.Inspect().Scripts[0].Vars[0].Val.Equal(Int(10)) {
		t.Fatal(g.Inspect())
	}
}

func TestHostFunctionCallDefaultsAndWrongArity(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "home", Source: "function sum a, b = 5\n return a + b\nend sum\non exported\n return sum\nend exported"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(0, 0)
	_, made, err := s.Request(context.Background(), Message{Name: "exported"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	fn, failure := made.Result()
	if failure != nil {
		t.Fatal(failure)
	}
	caller, ok := any(g).(interface {
		Call(context.Context, Value, []Value, *LimitOverride) (DeliveryID, *Pending, error)
	})
	if !ok {
		t.Fatal("Group.Call missing")
	}
	_, p, err := caller.Call(context.Background(), fn, []Value{Int(2)}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, bad, err := caller.Call(context.Background(), fn, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(now, PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	answer, failure := p.Result()
	if failure != nil || !answer.Equal(Int(7)) {
		t.Fatal(answer, failure, result)
	}
	_, failure = bad.Result()
	if failure == nil || failure.Data.Get("reason").String() != `"errored"` || failure.Data.Get("error").Get("code").String() != `"wrong arity"` {
		t.Fatal(failure, result)
	}
	for _, r := range result.Reports {
		if end, ok := r.(*RunEnd); ok && end.Outcome == Errored {
			if end.Fuel != 0 || end.Alloc != 0 {
				t.Fatal(end)
			}
			return
		}
	}
	t.Fatal("no wrong arity report", result)
}

func exportFunction(t *testing.T, g *Group, source string, limits Limits) (*Script, Value) {
	t.Helper()
	s, err := g.Load(LoadOptions{Name: "home", Source: source, Limits: limits})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := s.Request(context.Background(), Message{Name: "exported"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	fn, failure := p.Result()
	if failure != nil || fn.Kind() != KindFunction {
		t.Fatal(fn, failure)
	}
	return s, fn
}

func TestForeignFunctionFailureAndPlainCall(t *testing.T) {
	for _, body := range []string{"return callback(1)", "callback() and wait", "callback(1) and wait"} {
		t.Run(body, func(t *testing.T) {
			g := New().NewGroup(GroupOptions{})
			_, fn := exportFunction(t, g, "on exported\n return given n: 1 / 0\nend exported", Limits{})
			caller, err := g.Load(LoadOptions{Name: "caller", Source: "on go callback\n try\n  " + body + "\n catch e\n  return e\n end try\nend go"})
			if err != nil {
				t.Fatal(err)
			}
			_, p, err := caller.Request(context.Background(), Message{Name: "go", Args: []Value{fn}})
			if err != nil {
				t.Fatal(err)
			}
			result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			answer, failure := p.Result()
			if failure != nil {
				t.Fatal(failure, result)
			}
			want := map[string]string{"return callback(1)": "would suspend", "callback() and wait": "wrong arity", "callback(1) and wait": "send failed"}[body]
			if answer.Get("code").String() != mustPublicText(want).String() {
				t.Fatal(answer, result)
			}
			if want == "send failed" && (answer.Get("reason").String() != `"errored"` || answer.Get("error").Get("code").String() != `"division by zero"`) {
				t.Fatal(answer)
			}
		})
	}
}

func TestForeignFunctionTimeoutDoesNotCancelHome(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	home, fn := exportFunction(t, g, "script variable finished = false\non exported\n return given\n  wait 1s\n  put true into finished\n  return 9\n end given\nend exported", Limits{})
	caller, err := g.Load(LoadOptions{Name: "caller", Limits: Limits{MaxWait: time.Millisecond}, Source: "on go callback\n callback() and wait\n return it\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := caller.Request(context.Background(), Message{Name: "go", Args: []Value{fn}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(time.Unix(0, 0).Add(time.Millisecond), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	_, failure := p.Result()
	if failure == nil || failure.Data.Get("error").Get("code").String() != `"timeout"` {
		t.Fatal(failure)
	}
	if _, err := g.Pump(time.Unix(1, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if !g.Inspect().Scripts[0].Vars[0].Val.Equal(Bool(true)) || home.Counters().Runs != 2 {
		t.Fatal(g.Inspect(), home.Counters())
	}
}

func TestForeignFunctionUsesHomeBudgetsAndCallerDepth(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	_, fn := exportFunction(t, g, "on exported\n return given\n  repeat 20 times\n  end repeat\n end given\nend exported", Limits{FuelPerRun: 30})
	caller, err := g.Load(LoadOptions{Name: "caller", Limits: Limits{CallDepth: 1, FuelPerRun: 1000}, Source: "on go callback\n callback() and wait\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := caller.Request(context.Background(), Message{Name: "go", Args: []Value{fn}})
	if err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	_, failure := p.Result()
	if failure == nil || failure.Data.Get("error").Get("reason").String() != `"limit fault"` {
		t.Fatal(failure, result)
	}
	for _, r := range result.Reports {
		if end, ok := r.(*RunEnd); ok && end.Script == "home" {
			if end.Outcome != LimitFault || end.Limit != "fuel" || end.Fuel > 30 {
				t.Fatal(end)
			}
			return
		}
	}
	t.Fatal("no Home fault", result)
}

func TestHostFunctionCallStaleAndGroupValidation(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	home, fn := exportFunction(t, g, "on exported\n return given: 5\nend exported", Limits{})
	other := New().NewGroup(GroupOptions{})
	_, _, err := other.Call(context.Background(), fn, nil, nil)
	hostCode(t, err, WrongGroup)
	_, _, err = g.Call(context.Background(), Int(1), nil, nil)
	hostCode(t, err, InvalidValue)
	_, p, err := g.Call(context.Background(), fn, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := home.Reload("on other\nend other", ResetVariables); err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	_, failure := p.Result()
	if failure == nil || failure.Data.String() != `{reason: "function gone"}` || result.FuelUsed != 0 {
		t.Fatal(failure, result)
	}
	if len(result.Reports) != 0 {
		t.Fatal(result.Reports)
	}
}

func TestForeignFunctionResumeRestoresOrdinarySendWaitLabel(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	_, fn := exportFunction(t, g, "on exported\n return given: 7\nend exported\non ping\n wait 1s\nend ping", Limits{})
	caller, err := g.Load(LoadOptions{Name: "caller", Source: "on go callback\n callback() and wait\n send ping to home and wait\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := caller.Deliver(Message{Name: "go", Args: []Value{fn}}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	run := g.Inspect().Scripts[1].Runs[0]
	if run.Wait != "send-wait" {
		t.Fatal(run)
	}
}

func TestForeignFunctionMailboxFailureCreatesNoHomeRun(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	caller, err := g.Load(LoadOptions{Name: "caller", Source: "on go callback\n try\n  callback() and wait\n catch e\n  return e\n end try\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	home, fn := exportFunction(t, g, "on exported\n return given: 5\nend exported\non ping\nend ping", Limits{MailboxDepth: 1})
	if _, err := home.Deliver(Message{Name: "ping"}); err != nil {
		t.Fatal(err)
	}
	_, p, err := caller.Request(context.Background(), Message{Name: "go", Args: []Value{fn}})
	if err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	answer, failure := p.Result()
	if failure != nil || answer.Get("code").String() != `"mailbox full"` || answer.Get("to").String() != `"home"` {
		t.Fatal(answer, failure, result)
	}
	if home.Counters().Runs != 2 {
		t.Fatal(home.Counters())
	}
}

func TestForeignFunctionUsesHomeGrant(t *testing.T) {
	c := New()
	var scripts []string
	cap, err := c.DefineCapability("identity", Operation{Name: "who", Mode: Immediate, Result: TextShape, Do: func(call *Call, args []Value) (Value, error) {
		scripts = append(scripts, call.ScriptName())
		return mustPublicText(call.ScriptName()), nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	home, err := g.Load(LoadOptions{Name: "home", Grants: map[string]*Grant{"identity": cap.GrantAll(nil)}, Source: "on exported\n return given\n  ask identity to who\n  return it\n end given\nend exported"})
	if err != nil {
		t.Fatal(err)
	}
	_, made, err := home.Request(context.Background(), Message{Name: "exported"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	fn, failure := made.Result()
	if failure != nil {
		t.Fatal(failure)
	}
	caller, err := g.Load(LoadOptions{Name: "caller", Source: "on go callback\n callback() and wait\n return it\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := caller.Request(context.Background(), Message{Name: "go", Args: []Value{fn}})
	if err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	answer, failure := p.Result()
	if failure != nil || answer.String() != `"home"` || len(scripts) != 1 || scripts[0] != "home" {
		t.Fatal(answer, failure, scripts, result)
	}
}

func TestHostFunctionCancellationBeforeRunReleasesMailbox(t *testing.T) {
	ready := make(chan struct{}, 8)
	g := New().NewGroup(GroupOptions{OnReady: func() { ready <- struct{}{} }})
	home, fn := exportFunction(t, g, "on exported\n return given: 5\nend exported", Limits{MailboxDepth: 1})
	<-ready
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	id, p, err := g.Call(ctx, fn, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	<-ready
	cancel()
	select {
	case <-ready:
	case <-time.After(time.Second):
		t.Fatal("cancel not queued")
	}
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	_, failure := p.Result()
	if failure == nil || failure.Data.String() != `{reason: "cancelled"}` {
		t.Fatal(failure, result)
	}
	if home.Counters().Runs != 1 {
		t.Fatal(home.Counters())
	}
	if len(result.Reports) != 1 {
		t.Fatal(result.Reports)
	}
	end := result.Reports[0].(*RunEnd)
	if end.Delivery != id || end.Run != "" || end.Outcome != Cancelled {
		t.Fatal(end)
	}
	if _, _, err := g.Call(context.Background(), fn, nil, nil); err != nil {
		t.Fatal("cancel retained mailbox reservation", err)
	}
}

func TestForeignFunctionImportedDefaultsBindInOwnCodeUnit(t *testing.T) {
	c := New()
	library, err := c.CompileLibrary(LibrarySource{Name: "maths", Source: "function sum n = 5\n return n + 2\nend sum"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	if err := g.AddLibrary(library); err != nil {
		t.Fatal(err)
	}
	_, fn := exportFunction(t, g, "use sum from maths\non exported\n return sum\nend exported", Limits{})
	caller, err := g.Load(LoadOptions{Name: "caller", Source: "on go callback\n callback() and wait\n return it\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := caller.Request(context.Background(), Message{Name: "go", Args: []Value{fn}})
	if err != nil {
		t.Fatal(err)
	}
	_, host, err := g.Call(context.Background(), fn, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []*Pending{p, host} {
		answer, failure := p.Result()
		if failure != nil || !answer.Equal(Int(7)) {
			t.Fatal(answer, failure, result)
		}
	}
}

func TestHostFunctionCallDuringPumpWaitsForNextInputDrain(t *testing.T) {
	c := New()
	var g *Group
	var fn Value
	var pending *Pending
	queue, err := c.DefineCapability("queue", Operation{Name: "call", Mode: Immediate, Result: ValueShape, Do: func(*Call, []Value) (Value, error) {
		_, p, err := g.Call(context.Background(), fn, nil, nil)
		pending = p
		return Nothing, err
	}})
	if err != nil {
		t.Fatal(err)
	}
	g = c.NewGroup(GroupOptions{})
	home, exported := exportFunction(t, g, "on exported\n return given: 5\nend exported", Limits{})
	fn = exported
	caller, err := g.Load(LoadOptions{Name: "caller", Grants: map[string]*Grant{"queue": queue.GrantAll(nil)}, Source: "on go\n ask queue to call\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := caller.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if pending == nil || home.Counters().Runs != 1 {
		t.Fatal(pending, home.Counters())
	}
	select {
	case <-pending.Done():
		t.Fatal("Host input ran in original Pump")
	default:
	}
	result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	answer, failure := pending.Result()
	if failure != nil || !answer.Equal(Int(5)) {
		t.Fatal(answer, failure, result)
	}
}

func TestHostFunctionDisposeOrdering(t *testing.T) {
	for _, callFirst := range []bool{true, false} {
		t.Run(map[bool]string{true: "call first", false: "dispose first"}[callFirst], func(t *testing.T) {
			c := New()
			g := c.NewGroup(GroupOptions{})
			owner, _ := g.Object(objectKindForTest(t, c, "room"), "home", nil)
			s, err := g.Load(LoadOptions{Name: "home", Owner: owner, Source: "on exported\n return given: 5\nend exported"})
			if err != nil {
				t.Fatal(err)
			}
			_, made, err := s.Request(context.Background(), Message{Name: "exported"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
				t.Fatal(err)
			}
			fn, failure := made.Result()
			if failure != nil {
				t.Fatal(failure)
			}
			if !callFirst {
				if err := g.Dispose(owner); err != nil {
					t.Fatal(err)
				}
			}
			_, p, err := g.Call(context.Background(), fn, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			if callFirst {
				if err := g.Dispose(owner); err != nil {
					t.Fatal(err)
				}
			}
			result, err := g.Pump(time.Unix(0, 0), PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			want := "function gone"
			if callFirst {
				want = "stopped"
			}
			_, failure = p.Result()
			if failure == nil || failure.Data.Get("reason").String() != mustPublicText(want).String() || result.FuelUsed != 0 || result.State != Stopped {
				t.Fatal(failure, result)
			}
			if s.Counters().Runs != 1 {
				t.Fatal(s.Counters())
			}
		})
	}
}
