package northtalk

import (
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
)

// coordinatorLog records each hook as phase:grant,grant… with its bindings.
type coordinatorLog struct {
	calls []string
	fail  map[string]EffectStatus
}

func (l *coordinatorLog) hook(phase string) func(SegmentContext) EffectResult {
	return func(ctx SegmentContext) EffectResult {
		names := []string{}
		for _, g := range ctx.Grants {
			names = append(names, g.GrantName+"="+g.Binding.(string))
		}
		if ctx.GrantName != ctx.Grants[0].GrantName || ctx.Binding != ctx.Grants[0].Binding {
			return EffectResult{Status: EffectUnknown, Detail: "first Grant mismatch"}
		}
		l.calls = append(l.calls, phase+":"+strings.Join(names, ","))
		if status := l.fail[phase]; status != "" {
			return EffectResult{Status: status}
		}
		return EffectResult{Status: EffectOK}
	}
}

func (l *coordinatorLog) lifecycle() *SegmentLifecycle {
	return &SegmentLifecycle{Begin: l.hook("begin"), Commit: l.hook("commit"), Rollback: l.hook("rollback")}
}

func coordinatedWrite(log *[]string) Operation {
	return Operation{Name: "write", Mode: Immediate, SegmentBound: true, Result: NothingShape, Do: func(call *Call, _ []Value) (Value, error) {
		*log = append(*log, "write:"+call.GrantName())
		return Nothing, nil
	}}
}

func TestCoordinatedCapabilityDefinitions(t *testing.T) {
	c := New()
	var writes []string
	if _, err := c.DefineCoordinatedCapability("db", nil, coordinatedWrite(&writes)); err == nil {
		t.Fatal("missing coordinator mapping accepted")
	}
	shared := (&coordinatorLog{}).lifecycle()
	mapped := 0
	d, err := c.DefineCoordinatedCapability("db", func(binding any) *SegmentLifecycle {
		mapped++
		switch binding {
		case "none":
			return nil
		case "partial":
			return &SegmentLifecycle{Begin: effectOK, Commit: effectOK}
		}
		return shared
	}, coordinatedWrite(&writes))
	if err != nil {
		t.Fatal(err)
	}
	for _, binding := range []string{"none", "partial"} {
		var host *HostError
		if _, err := d.Grant([]string{"write"}, binding); !errors.As(err, &host) || host.Code != InvalidValue {
			t.Fatal(binding, err)
		}
		if d.GrantAll(binding) != nil {
			t.Fatal("GrantAll accepted a binding without a coordinator")
		}
	}
	mapped = 0
	template := d.GrantAll("x")
	g := c.NewGroup(GroupOptions{})
	if _, err := g.Load(LoadOptions{Name: "s", Grants: map[string]*Grant{"a": template, "b": template}, Source: "on go\nend go\n"}); err != nil {
		t.Fatal(err)
	}
	if mapped != 1 {
		t.Fatal("coordinator mapped outside Grant creation:", mapped)
	}
}

func TestCoordinatorSharesOneParticipantAcrossGrantsAndAliases(t *testing.T) {
	c := New()
	var writes []string
	log, other := &coordinatorLog{}, &coordinatorLog{}
	shared, separate := log.lifecycle(), other.lifecycle()
	d, err := c.DefineCoordinatedCapability("db", func(binding any) *SegmentLifecycle {
		if binding == "elsewhere" {
			return separate
		}
		return shared
	}, coordinatedWrite(&writes))
	if err != nil {
		t.Fatal(err)
	}
	plain, err := c.DefineSegmentCapability("plain", *shared, coordinatedWrite(&writes))
	if err != nil {
		t.Fatal(err)
	}
	var trace lines
	g := c.NewGroup(GroupOptions{Trace: &trace})
	template := d.GrantAll("x")
	plainTemplate := plain.GrantAll("p")
	source := "on go\nask a to write\nask alias to write\nask y to write\nask a to write\nend go\n" +
		"on other\nask a to write\nask z to write\nend other\n" +
		"on plain\nask p to write\nask q to write\nend plain\n"
	s, err := g.Load(LoadOptions{Name: "s", Grants: map[string]*Grant{"a": template, "alias": template, "y": d.GrantAll("y"), "z": d.GrantAll("elsewhere"), "p": plainTemplate, "q": plainTemplate}, Source: source})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if want := []string{"begin:a=x", "commit:a=x,alias=x,y=y"}; !slices.Equal(log.calls, want) {
		t.Fatal(log.calls)
	}
	if want := []string{"write:a", "write:alias", "write:y", "write:a"}; !slices.Equal(writes, want) {
		t.Fatal(writes)
	}
	records := strings.Join(trace, "\n")
	if strings.Count(records, "effect s/r1.s1 grant=a") != 2 || strings.Contains(records, "grant=alias phase") {
		t.Fatal(records)
	}

	// A Grant mapped to another coordinator conflicts and names the first
	// enrolled Grant; its Host is not entered.
	log.calls, writes = nil, nil
	if _, err := s.Deliver(Message{Name: "other"}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(writes, []string{"write:a"}) || len(other.calls) != 0 || !slices.Equal(log.calls, []string{"begin:a=x", "commit:a=x"}) {
		t.Fatal(writes, other.calls, log.calls)
	}
	if records := strings.Join(trace, "\n"); !strings.Contains(records, `code: "segment participant conflict"`) || !strings.Contains(records, `participant: "a"`) || !strings.Contains(records, `capability: "z"`) {
		t.Fatal(records)
	}

	// A plain lifecycle keeps one coordinator per named Grant, aliases included.
	log.calls, writes = nil, nil
	if _, err := s.Deliver(Message{Name: "plain"}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(writes, []string{"write:p"}) || !slices.Equal(log.calls, []string{"begin:p=p", "commit:p=p"}) {
		t.Fatal(writes, log.calls)
	}
	if records := strings.Join(trace, "\n"); !strings.Contains(records, `participant: "p"`) || !strings.Contains(records, `capability: "q"`) {
		t.Fatal(records)
	}
}

func TestCoordinatorRollbackCoversEveryEnrolledGrant(t *testing.T) {
	c := New()
	var writes []string
	log := &coordinatorLog{}
	shared := log.lifecycle()
	d, err := c.DefineCoordinatedCapability("db", func(any) *SegmentLifecycle { return shared }, coordinatedWrite(&writes))
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Grants: map[string]*Grant{"a": d.GrantAll("x"), "b": d.GrantAll("y")}, Source: "on go\nask b to write\nask a to write\nrepeat forever\nend repeat\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(time.Unix(0, 0), PumpOptions{FuelSlice: 40}); err != nil {
		t.Fatal(err)
	}
	s.Stop("done")
	if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if want := []string{"begin:b=y", "rollback:b=y,a=x"}; !slices.Equal(log.calls, want) {
		t.Fatal(log.calls)
	}
}

// scopedCoordinated defines Segment-bound open/close scopes on one shared
// coordinator; closing through a Grant named in failing fails abandonment.
func scopedCoordinated(t *testing.T, c *Core, name string, lifecycle *SegmentLifecycle, events *[]string, failing string) *CapabilityDef {
	t.Helper()
	d, err := c.DefineCoordinatedCapability(name, func(any) *SegmentLifecycle { return lifecycle },
		Operation{Name: "open", Mode: Immediate, SegmentBound: true, Result: NothingShape, Scope: &ScopeDecl{Opens: "tx", Abandon: "close"}, Do: func(call *Call, _ []Value) (Value, error) {
			*events = append(*events, "open:"+call.GrantName())
			return Nothing, nil
		}},
		Operation{Name: "close", Mode: Immediate, SegmentBound: true, Result: NothingShape, Scope: &ScopeDecl{Closes: "tx"}, Do: func(call *Call, _ []Value) (Value, error) {
			*events = append(*events, "close:"+call.GrantName())
			if call.GrantName() == failing {
				return Nothing, errors.New("stuck")
			}
			return Nothing, nil
		}})
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestCoordinatorAbandonmentFailureOnEitherGrantPreventsCommit(t *testing.T) {
	for _, failing := range []string{"a", "b"} {
		t.Run(failing, func(t *testing.T) {
			c := New()
			var events []string
			log := &coordinatorLog{}
			d := scopedCoordinated(t, c, "db", log.lifecycle(), &events, failing)
			g := c.NewGroup(GroupOptions{})
			s, err := g.Load(LoadOptions{Name: "s", Grants: map[string]*Grant{"a": d.GrantAll("x"), "b": d.GrantAll("y")}, Source: "script variable n = 0\non go\nput 1 into n\nask a to open\nask b to open\nend go\n"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.Deliver(Message{Name: "go"}); err != nil {
				t.Fatal(err)
			}
			r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if want := []string{"begin:a=x", "rollback:a=x,b=y"}; !slices.Equal(log.calls, want) {
				t.Fatal(log.calls)
			}
			if want := []string{"open:a", "open:b", "close:b", "close:a"}; !slices.Equal(events, want) {
				t.Fatal(events)
			}
			inspect := g.Inspect().Scripts[0]
			if !slices.Equal(inspect.DisabledGrants, []string{failing}) || !inspect.Vars[0].Val.Equal(Int(0)) {
				t.Fatal(inspect)
			}
			var effect *EffectFailure
			for _, report := range r.Reports {
				if e, ok := report.(*EffectFailure); ok && e.Phase == "abandon" {
					effect = e
				}
			}
			if effect == nil || effect.Grant != failing {
				t.Fatal(r.Reports)
			}
		})
	}
}

func TestCoordinatorCancellationAbandonsEveryEnrolledGrantBeforeRollback(t *testing.T) {
	c := New()
	var events []string
	log := &coordinatorLog{}
	lifecycle := log.lifecycle()
	rollback := lifecycle.Rollback
	lifecycle.Rollback = func(ctx SegmentContext) EffectResult {
		events = append(events, "rollback")
		return rollback(ctx)
	}
	d := scopedCoordinated(t, c, "db", lifecycle, &events, "")
	u, err := c.DefineCapability("file",
		Operation{Name: "open", Mode: Immediate, Result: NothingShape, Scope: &ScopeDecl{Opens: "f", Abandon: "close"}, Do: func(call *Call, _ []Value) (Value, error) {
			events = append(events, "open:"+call.GrantName())
			return Nothing, nil
		}},
		Operation{Name: "close", Mode: Immediate, Result: NothingShape, Scope: &ScopeDecl{Closes: "f"}, Do: func(call *Call, _ []Value) (Value, error) {
			events = append(events, "close:"+call.GrantName())
			return Nothing, nil
		}})
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Grants: map[string]*Grant{"a": d.GrantAll("x"), "b": d.GrantAll("y"), "u": u.GrantAll(nil)}, Source: "on go\nask a to open\nask u to open\nask b to open\nrepeat forever\nend repeat\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(time.Unix(0, 0), PumpOptions{FuelSlice: 60}); err != nil {
		t.Fatal(err)
	}
	s.CancelRun("s/r1")
	if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if want := []string{"open:a", "open:u", "open:b", "close:b", "close:a", "rollback", "close:u"}; !slices.Equal(events, want) {
		t.Fatal(events)
	}
	if want := []string{"begin:a=x", "rollback:a=x,b=y"}; !slices.Equal(log.calls, want) {
		t.Fatal(log.calls)
	}
}

func TestCoordinatorMappingHoldsAcrossReloadAndRestore(t *testing.T) {
	c := New()
	var writes []string
	log := &coordinatorLog{}
	shared := log.lifecycle()
	mapped := 0
	d, err := c.DefineCoordinatedCapability("db", func(any) *SegmentLifecycle {
		mapped++
		return shared
	}, coordinatedWrite(&writes))
	if err != nil {
		t.Fatal(err)
	}
	source := "on go\nask a to write\nask b to write\nend go\n"
	g := c.NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Grants: map[string]*Grant{"a": d.GrantAll("x"), "b": d.GrantAll("y")}, Source: "on go\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reload(source, CarryVariables); err != nil {
		t.Fatal(err)
	}
	if mapped != 2 {
		t.Fatal("Reload remapped coordinators:", mapped)
	}
	run := func(g *Group) {
		t.Helper()
		log.calls = nil
		if _, err := g.Script("s").Deliver(Message{Name: "go"}); err != nil {
			t.Fatal(err)
		}
		if _, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
			t.Fatal(err)
		}
		if want := []string{"begin:a=x", "commit:a=x,b=y"}; !slices.Equal(log.calls, want) {
			t.Fatal(log.calls)
		}
	}
	run(g)
	save, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	restored, _, err := c.Restore(save, RestoreOptions{Grants: func(_, name string) *Grant {
		return d.GrantAll(map[string]string{"a": "x", "b": "y"}[name])
	}})
	if err != nil {
		t.Fatal(err)
	}
	if mapped != 4 {
		t.Fatal("Restore mapped outside Host Grant creation:", mapped)
	}
	run(restored)
}
