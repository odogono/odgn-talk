package northtalk

import (
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
)

func effectOK(SegmentContext) EffectResult { return EffectResult{Status: EffectOK} }

func TestSegmentCapabilityDefinitions(t *testing.T) {
	c := New()
	op := Operation{Name: "write", Mode: Immediate, SegmentBound: true, Result: NothingShape, Do: func(*Call, []Value) (Value, error) { return Nothing, nil }}
	hooks := SegmentLifecycle{Begin: effectOK, Commit: effectOK, Rollback: effectOK}
	if _, err := c.DefineCapability("r", op); err == nil {
		t.Fatal("ordinary definition accepted missing lifecycle")
	}
	for _, bad := range []SegmentLifecycle{{}, {Begin: effectOK, Commit: effectOK}, {Begin: effectOK, Rollback: effectOK}, {Commit: effectOK, Rollback: effectOK}} {
		if _, err := c.DefineSegmentCapability("r", bad, op); err == nil {
			t.Fatal("incomplete lifecycle accepted")
		}
	}
	for _, mode := range []Mode{Suspending, FireAndForget} {
		bad := op
		bad.Mode = mode
		bad.Do = nil
		if mode == Suspending {
			bad.Start = func(*Call, []Value) error { return nil }
		} else {
			bad.Fire = func(*Call, []Value) error { return nil }
		}
		if _, err := c.DefineSegmentCapability("r", hooks, bad); err == nil {
			t.Fatal("non-immediate participant accepted")
		}
	}
	open := op
	open.Name = "open"
	open.Scope = &ScopeDecl{Opens: "file", Abandon: "close"}
	close := op
	close.Name = "close"
	close.Scope = &ScopeDecl{Closes: "file"}
	close.SegmentBound = false
	if _, err := c.DefineSegmentCapability("r", hooks, open, close); err == nil {
		t.Fatal("inconsistent lifecycle scope accepted")
	}
}

func TestSegmentParticipantSurvivesPreemptionAndCommitsBeforeQueuedStop(t *testing.T) {
	c := New()
	var trace lines
	staged, published := 0, 0
	var contexts []SegmentContext
	var reentry error
	var g *Group
	hooks := SegmentLifecycle{
		Begin: func(ctx SegmentContext) EffectResult {
			contexts = append(contexts, ctx)
			_, reentry = ctx.Group.Load(LoadOptions{Name: "reentry"})
			return effectOK(ctx)
		},
		Commit: func(ctx SegmentContext) EffectResult {
			contexts = append(contexts, ctx)
			published += staged
			staged = 0
			ctx.Group.Script(ctx.ScriptName).Stop("committed")
			return effectOK(ctx)
		},
		Rollback: func(SegmentContext) EffectResult {
			t.Fatal("committed Segment rolled back")
			return EffectResult{Status: EffectUnknown}
		},
	}
	d, err := c.DefineSegmentCapability("r", hooks, Operation{Name: "write", Mode: Immediate, SegmentBound: true, Result: NothingShape, Do: func(call *Call, _ []Value) (Value, error) {
		if call.Group() != g || call.RunID() != "s/r1" || call.GrantName() != "r" || call.SegmentID() != "s/r1.s1" || call.Binding() != "binding" {
			t.Fatal(call)
		}
		staged++
		return Nothing, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	// Mutating the original lifecycle does not mutate the registered definition.
	hooks.Commit = func(SegmentContext) EffectResult { return EffectResult{Status: EffectFailed} }
	g = c.NewGroup(GroupOptions{Trace: &trace})
	s, err := g.Load(LoadOptions{Name: "s", Grants: map[string]*Grant{"r": d.GrantAll("binding")}, Source: "script variable count = 0\non go\nask r to write\nput 1 into count\nput 2 into count\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := s.Request(nil, Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(100, 200).UTC()
	r, err := g.Pump(now, PumpOptions{FuelSlice: 15})
	if err != nil || r.State != Sliced || staged != 1 || published != 0 || len(contexts) != 1 {
		t.Fatal(r, err, staged, published, contexts)
	}
	r, err = g.Pump(now, PumpOptions{})
	if err != nil || r.State != Stopped || staged != 0 || published != 1 || len(contexts) != 2 {
		t.Fatal(r, err, staged, published, contexts)
	}
	for _, ctx := range contexts {
		if ctx.Group != g || ctx.Binding != "binding" || ctx.ScriptName != "s" || ctx.RunID != "s/r1" || ctx.GrantName != "r" || ctx.SegmentID != "s/r1.s1" || !ctx.Now.Equal(now) {
			t.Fatal(ctx)
		}
	}
	var host *HostError
	if !errors.As(reentry, &host) || host.Code != ReentrantCall {
		t.Fatal(reentry)
	}
	select {
	case <-p.Done():
	default:
		t.Fatal("completed Request did not settle")
	}
	_, failed := p.Result()
	if failed != nil || !g.Inspect().Scripts[0].Vars[0].Val.Equal(Int(2)) {
		t.Fatal(failed, g.Inspect())
	}
	records := strings.Join(trace, "\n")
	if strings.Index(records, "phase=commit status=ok") > strings.Index(records, `> stop s reason="committed"`) {
		t.Fatal(records)
	}
}

func TestEffectUncertaintyStopsEveryScriptAndCannotReload(t *testing.T) {
	for _, phase := range []string{"begin", "commit", "rollback", "reload", "stop"} {
		statuses := []EffectStatus{EffectUnknown, "malformed", "panic"}
		if phase == "rollback" || phase == "reload" || phase == "stop" {
			statuses = append(statuses, EffectFailed)
		}
		for _, status := range statuses {
			t.Run(phase+"/"+string(status), func(t *testing.T) {
				c := New()
				rolledBack := 0
				uncertain := func(SegmentContext) EffectResult {
					if status == "panic" {
						panic("private host detail")
					}
					return EffectResult{Status: status}
				}
				hooks := SegmentLifecycle{Begin: effectOK, Commit: effectOK, Rollback: func(ctx SegmentContext) EffectResult {
					rolledBack++
					if phase == "rollback" || phase == "reload" || phase == "stop" {
						return uncertain(ctx)
					}
					return effectOK(ctx)
				}}
				if phase == "begin" {
					hooks.Begin = uncertain
				}
				if phase == "commit" {
					hooks.Commit = uncertain
				}
				d, err := c.DefineSegmentCapability("r", hooks, Operation{Name: "write", Mode: Immediate, SegmentBound: true, Result: NothingShape, Do: func(*Call, []Value) (Value, error) { return Nothing, nil }})
				if err != nil {
					t.Fatal(err)
				}
				var trace lines
				g := c.NewGroup(GroupOptions{Trace: &trace})
				before, err := g.Load(LoadOptions{Name: "before", Source: "on go\nwait 1 s\nend go\n"})
				if err != nil {
					t.Fatal(err)
				}
				body := "ask r to write\nput 9 into count"
				if phase == "rollback" || phase == "reload" || phase == "stop" {
					body += "\nrepeat forever\nend repeat"
				}
				s, err := g.Load(LoadOptions{Name: "s", Grants: map[string]*Grant{"r": d.GrantAll(nil)}, Limits: Limits{FuelPerRun: 80}, Source: "script variable count = 0\non go\n" + body + "\nend go\n"})
				if err != nil {
					t.Fatal(err)
				}
				after, err := g.Load(LoadOptions{Name: "after", Source: "on go\nreturn 7\nend go\n"})
				if err != nil {
					t.Fatal(err)
				}
				_, first, err := before.Request(nil, Message{Name: "go"})
				if err != nil {
					t.Fatal(err)
				}
				_, active, err := s.Request(nil, Message{Name: "go"})
				if err != nil {
					t.Fatal(err)
				}
				_, last, err := after.Request(nil, Message{Name: "go"})
				if err != nil {
					t.Fatal(err)
				}
				now := time.Unix(0, 0)
				opts := PumpOptions{}
				if phase == "reload" || phase == "stop" {
					opts.FuelSlice = 25
				}
				r, err := g.Pump(now, opts)
				if err != nil {
					t.Fatal(err)
				}
				if phase == "reload" {
					_, err = s.Reload("script variable count = 100\non go\nreturn count\nend go\n", CarryVariables)
					var host *HostError
					if !errors.As(err, &host) || host.Code != EffectStateUnknown {
						t.Fatal(err)
					}
					r, err = g.Pump(now, PumpOptions{})
				} else if phase == "stop" {
					s.Stop("requested")
					r, err = g.Pump(now, PumpOptions{})
				}
				if err != nil || r.State != Stopped || rolledBack != 1 {
					t.Fatal(r, err, rolledBack)
				}
				for _, script := range []*Script{before, s, after} {
					if !script.stopped {
						t.Fatal("Script not stopped", script.name)
					}
				}
				for _, p := range []*Pending{first, active, last} {
					select {
					case <-p.Done():
					default:
						t.Fatal("Request not settled")
					}
				}
				if !g.Inspect().Scripts[1].Vars[0].Val.Equal(Int(0)) {
					t.Fatal(g.Inspect())
				}
				_, err = s.Reload("on go\nend go", ResetVariables)
				var host *HostError
				if !errors.As(err, &host) || host.Code != EffectStateUnknown {
					t.Fatal(err)
				}
				_, err = g.Load(LoadOptions{Name: "fresh", Source: "on go\nend go"})
				if !errors.As(err, &host) || host.Code != EffectStateUnknown {
					t.Fatal(err)
				}
				records := strings.Join(trace, "\n")
				var stops []string
				for _, line := range trace {
					if strings.HasPrefix(line, "stopped ") {
						stops = append(stops, strings.Fields(line)[1])
						if !strings.Contains(line, `reason="effect state unknown"`) {
							t.Fatal(line)
						}
					}
				}
				if !slices.Equal(stops, []string{"before", "s", "after"}) {
					t.Fatal(stops, records)
				}
				if strings.Contains(records, "private host detail") || strings.Contains(records, "status=malformed") || strings.Contains(records, "status=panic") {
					t.Fatal(records)
				}
			})
		}
	}
}

func TestDefiniteCommitFailureFailsWaitingSenderWithoutFaultOrErrorHandler(t *testing.T) {
	c := New()
	marked, rolledBack := 0, 0
	d, err := c.DefineSegmentCapability("r", SegmentLifecycle{Begin: effectOK, Commit: func(SegmentContext) EffectResult { return EffectResult{Status: EffectFailed, Detail: "private"} }, Rollback: func(ctx SegmentContext) EffectResult { rolledBack++; return effectOK(ctx) }}, Operation{Name: "write", Mode: Immediate, SegmentBound: true, Result: NothingShape, Do: func(*Call, []Value) (Value, error) { return Nothing, nil }}, Operation{Name: "mark", Mode: Immediate, Result: NothingShape, Do: func(*Call, []Value) (Value, error) { marked++; return Nothing, nil }})
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	receiver, err := g.Load(LoadOptions{Name: "receiver", Grants: map[string]*Grant{"r": d.GrantAll(nil)}, Source: "script variable count = 0\non go\nask r to write\nput 9 into count\nend go\non error e\nask r to mark\nend error\n"})
	if err != nil {
		t.Fatal(err)
	}
	sender, err := g.Load(LoadOptions{Name: "sender", Source: "on go\ntry\nsend go to receiver and wait\ncatch e\nreturn the reason of e\nend try\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := sender.Request(nil, Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	v, failed := p.Result()
	if failed != nil || v.String() != `"effect failed"` || receiver.Counters().Faults != 0 || marked != 0 || rolledBack != 1 || !g.Inspect().Scripts[0].Vars[0].Val.Equal(Int(0)) {
		t.Fatal(v, failed, receiver.Counters(), marked, rolledBack)
	}
}

func TestSegmentParticipantRollbackAfterExplicitCloseAndPreemption(t *testing.T) {
	c := New()
	staged, published, rollbacks, closes := 0, 0, 0, 0
	d, err := c.DefineSegmentCapability("r", SegmentLifecycle{
		Begin:    effectOK,
		Commit:   func(ctx SegmentContext) EffectResult { published += staged; staged = 0; return effectOK(ctx) },
		Rollback: func(ctx SegmentContext) EffectResult { rollbacks++; staged = 0; return effectOK(ctx) },
	}, Operation{Name: "open", Mode: Immediate, SegmentBound: true, Result: NothingShape, Scope: &ScopeDecl{Opens: "file", Abandon: "close"}, Do: func(*Call, []Value) (Value, error) { staged++; return Nothing, nil }}, Operation{Name: "close", Mode: Immediate, SegmentBound: true, Result: NothingShape, Scope: &ScopeDecl{Closes: "file"}, Do: func(call *Call, _ []Value) (Value, error) {
		if call.Automatic() {
			t.Fatal("explicit close was repeated")
		}
		closes++
		return Nothing, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Grants: map[string]*Grant{"r": d.GrantAll(nil)}, Limits: Limits{FuelPerRun: 80}, Source: "script variable count = 0\non go\nask r to open\nask r to close\nput 9 into count\nrepeat forever\nend repeat\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{FuelSlice: 30})
	if err != nil || r.State != Sliced || staged != 1 || published != 0 || closes != 1 || rollbacks != 0 {
		t.Fatal(r, err, staged, published, closes, rollbacks)
	}
	r, err = g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || len(operationalReports(r.Reports)) != 1 || operationalReports(r.Reports)[0].(*RunEnd).Outcome != LimitFault || staged != 0 || published != 0 || closes != 1 || rollbacks != 1 || !g.Inspect().Scripts[0].Vars[0].Val.Equal(Int(0)) {
		t.Fatal(r, err, staged, published, closes, rollbacks, g.Inspect())
	}
}

func TestOwnerDisposalRollsBackParticipantWithoutScriptFinally(t *testing.T) {
	c := New()
	staged, rollbacks, cleanup := 0, 0, 0
	d, err := c.DefineSegmentCapability("r", SegmentLifecycle{Begin: effectOK, Commit: effectOK, Rollback: func(ctx SegmentContext) EffectResult { rollbacks++; staged = 0; return effectOK(ctx) }}, Operation{Name: "write", Mode: Immediate, SegmentBound: true, Result: NothingShape, Do: func(*Call, []Value) (Value, error) { staged++; return Nothing, nil }}, Operation{Name: "cleanup", Mode: Immediate, Result: NothingShape, Do: func(*Call, []Value) (Value, error) { cleanup++; return Nothing, nil }})
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	kind, err := c.DefineObjectKind(ObjectKindDef{Name: "owner"})
	if err != nil {
		t.Fatal(err)
	}
	owner, err := g.Object(kind, "one", nil)
	if err != nil {
		t.Fatal(err)
	}
	s, err := g.Load(LoadOptions{Name: "s", Owner: owner, Grants: map[string]*Grant{"r": d.GrantAll(nil)}, Source: "script variable count = 0\non go\ntry\nask r to write\nput 9 into count\nrepeat forever\nend repeat\nfinally\nask r to cleanup\nend try\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := s.Request(nil, Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(time.Unix(0, 0), PumpOptions{FuelSlice: 25}); err != nil {
		t.Fatal(err)
	}
	if err := g.Dispose(owner); err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	_, failed := p.Result()
	if err != nil || r.State != Stopped || staged != 0 || rollbacks != 1 || cleanup != 0 || failed == nil || !g.Inspect().Scripts[0].Vars[0].Val.Equal(Int(0)) {
		t.Fatal(r, err, failed, staged, rollbacks, cleanup, g.Inspect())
	}
}
