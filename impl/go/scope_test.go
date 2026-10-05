package northtalk

import (
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"
)

func TestScopeDefinitionsAndGrantDependencies(t *testing.T) {
	open := Operation{Name: "open", Mode: Immediate, Result: NothingShape, Scope: &ScopeDecl{Opens: "file", Abandon: "close"}, Do: func(*Call, []Value) (Value, error) { return Nothing, nil }}
	close := Operation{Name: "close", Mode: Immediate, Result: NothingShape, Scope: &ScopeDecl{Closes: "file"}, Do: open.Do}
	c := New()
	d, err := c.DefineCapability("resource", open, close)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Grant([]string{"open"}, nil); err == nil {
		t.Fatal("opener Grant omitted its abandonment Operation")
	}
	if _, err := d.Grant([]string{"open", "close"}, nil); err != nil {
		t.Fatal(err)
	}
	for _, scope := range []ScopeDecl{{}, {Opens: "file"}, {Closes: "file", Abandon: "close"}, {Opens: "file", Closes: "file", Abandon: "close"}, {Opens: "two words", Abandon: "close"}} {
		t.Run(scope.Opens+"/"+scope.Closes+"/"+scope.Abandon, func(t *testing.T) {
			bad := open
			bad.Scope = &scope
			if _, err := c.DefineCapability("invalid", bad, close); err == nil {
				t.Fatal("invalid scope declaration accepted")
			}
		})
	}
	open.Scope.Abandon = "missing"
	close.Scope.Closes = "changed"
	g := c.NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Grants: map[string]*Grant{"r": d.GrantAll(nil)}, Source: "on go\n ask r to open\nend go\n"})
	if err != nil {
		t.Fatal("scope metadata was not copied:", err)
	}
	if _, err := s.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	if r, err := g.Pump(time.Unix(0, 0), PumpOptions{}); err != nil || len(r.Reports) != 1 {
		t.Fatal(r, err)
	}
}

func TestScopeGuardsExecutedSuspensionBoundaries(t *testing.T) {
	for _, boundary := range []string{"wait 0 ms", "wait for ping", "send ping to me and wait", "ask r to later and wait", "wait for all\n repeat 0 times\n ask r to later and wait\n end repeat\nend wait", "wait for all\nask r to later and wait\nend wait", "helper and wait"} {
		t.Run(boundary, func(t *testing.T) {
			c := New()
			opened, closed, started := 0, 0, 0
			d, err := c.DefineCapability("resource",
				Operation{Name: "open", Mode: Immediate, Result: NothingShape, Scope: &ScopeDecl{Opens: "file", Abandon: "close"}, Do: func(*Call, []Value) (Value, error) { opened++; return Nothing, nil }},
				Operation{Name: "close", Mode: Immediate, Result: NothingShape, Scope: &ScopeDecl{Closes: "file"}, Do: func(*Call, []Value) (Value, error) { closed++; return Nothing, nil }},
				Operation{Name: "later", Mode: Suspending, Result: NothingShape, Start: func(*Call, []Value) error { started++; return nil }})
			if err != nil {
				t.Fatal(err)
			}
			g := c.NewGroup(GroupOptions{})
			source := fmt.Sprintf("on go\n ask r to open\n try\n%s\n catch e\n return the code of e\n end try\nend go\non helper\n wait for ping\nend helper\n", boundary)
			s, err := g.Load(LoadOptions{Name: "s", Source: source, Grants: map[string]*Grant{"r": d.GrantAll(nil)}})
			if err != nil {
				t.Fatal(err)
			}
			_, p, err := s.Request(nil, Message{Name: "go"})
			if err != nil {
				t.Fatal(err)
			}
			r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
			v, failure := p.Result()
			if err != nil || failure != nil || v.String() != `"scope open"` || opened != 1 || closed != 1 || started != 0 || len(g.Inspect().Scripts[0].Mailbox) != 0 {
				t.Fatal(r, err, v, failure, opened, closed, started)
			}
		})
	}
}

func TestScopeAllowsLocalWaitMarkedCallsAndRefusesJoinAcquisition(t *testing.T) {
	for _, joining := range []bool{false, true} {
		t.Run(fmt.Sprint(joining), func(t *testing.T) {
			c := New()
			opened := 0
			d, err := c.DefineCapability("resource",
				Operation{Name: "open", Mode: Immediate, Result: NothingShape, Scope: &ScopeDecl{Opens: "file", Abandon: "close"}, Do: func(*Call, []Value) (Value, error) { opened++; return Nothing, nil }},
				Operation{Name: "close", Mode: Immediate, Result: NothingShape, Scope: &ScopeDecl{Closes: "file"}, Do: func(*Call, []Value) (Value, error) { return Nothing, nil }})
			if err != nil {
				t.Fatal(err)
			}
			body := "ask r to open\n local and wait\n return it"
			local := "return 7"
			if joining {
				body = "wait for all\n local\n send ping to me and wait\nend wait"
				local = "ask r to open"
			}
			g := c.NewGroup(GroupOptions{})
			s, err := g.Load(LoadOptions{Name: "s", Grants: map[string]*Grant{"r": d.GrantAll(nil)}, Source: "on go\n" + body + "\nend go\non local\n" + local + "\nend local\n"})
			if err != nil {
				t.Fatal(err)
			}
			_, p, err := s.Request(nil, Message{Name: "go"})
			if err != nil {
				t.Fatal(err)
			}
			r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
			v, failure := p.Result()
			if joining {
				if err != nil || failure == nil || r.Reports[0].(*RunEnd).Error.Code != "scope in join" || opened != 0 {
					t.Fatal(r, err, failure, opened)
				}
			} else if err != nil || failure != nil || v.String() != "7" || opened != 1 {
				t.Fatal(r, err, v, failure, opened)
			}
		})
	}
}

func TestScopeRejectsForeignFunctionWaitBeforeDelivery(t *testing.T) {
	c := New()
	d, err := c.DefineCapability("resource",
		Operation{Name: "open", Mode: Immediate, Result: NothingShape, Scope: &ScopeDecl{Opens: "file", Abandon: "close"}, Do: func(*Call, []Value) (Value, error) { return Nothing, nil }},
		Operation{Name: "close", Mode: Immediate, Result: NothingShape, Scope: &ScopeDecl{Closes: "file"}, Do: func(*Call, []Value) (Value, error) { return Nothing, nil }})
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	home, fn := exportFunction(t, g, "on exported\n return given n: n\nend exported", Limits{})
	s, err := g.Load(LoadOptions{Name: "s", Grants: map[string]*Grant{"r": d.GrantAll(nil)}, Source: "on go callback\n ask r to open\n callback(7) and wait\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := s.Request(nil, Message{Name: "go", Args: []Value{fn}})
	if err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	_, failure := p.Result()
	if err != nil || failure == nil || r.Reports[0].(*RunEnd).Error.Code != "scope open" || home.Counters().Runs != 1 {
		t.Fatal(r, err, failure, home.Counters())
	}
}

func TestScopeSlotsAndDisablementAreIsolatedAcrossAliasesAndGroups(t *testing.T) {
	c := New()
	var first *Group
	opened := map[*Group]map[string]bool{}
	binding := &struct{}{}
	d, err := c.DefineCapability("resource",
		Operation{Name: "open", Mode: Immediate, Result: NothingShape, Scope: &ScopeDecl{Opens: "file", Abandon: "close"}, Do: func(call *Call, _ []Value) (Value, error) {
			if call.Binding() != binding {
				t.Fatal(call.Binding())
			}
			if opened[call.Group()] == nil {
				opened[call.Group()] = map[string]bool{}
			}
			if opened[call.Group()][call.GrantName()] {
				t.Fatal("shared scope slot")
			}
			opened[call.Group()][call.GrantName()] = true
			return Nothing, nil
		}},
		Operation{Name: "close", Mode: Immediate, Result: NothingShape, Scope: &ScopeDecl{Closes: "file"}, Do: func(call *Call, _ []Value) (Value, error) {
			if !call.Automatic() || !opened[call.Group()][call.GrantName()] {
				t.Fatal(call)
			}
			if call.Group() == first && call.GrantName() == "alias" {
				return Nothing, errors.New("quarantined")
			}
			delete(opened[call.Group()], call.GrantName())
			return Nothing, nil
		}})
	if err != nil {
		t.Fatal(err)
	}
	template := d.GrantAll(binding)
	first = c.NewGroup(GroupOptions{})
	second := c.NewGroup(GroupOptions{})
	for _, g := range []*Group{first, second} {
		s, err := g.Load(LoadOptions{Name: "s", Grants: map[string]*Grant{"r": template, "alias": template}, Source: "on go\n ask r to open\n ask alias to open\n repeat forever\n end repeat\nend go\n"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.Deliver(Message{Name: "go"}); err != nil {
			t.Fatal(err)
		}
		if _, err := g.Pump(time.Unix(0, 0), PumpOptions{FuelSlice: 40}); err != nil {
			t.Fatal(err)
		}
	}
	if len(opened[first]) != 2 || len(opened[second]) != 2 {
		t.Fatal(opened)
	}
	first.Script("s").Stop("done")
	if _, err := first.Pump(time.Unix(0, 0), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(first.Inspect().Scripts[0].DisabledGrants, []string{"alias"}) || len(second.Inspect().Scripts[0].DisabledGrants) != 0 || len(opened[second]) != 2 {
		t.Fatal(first.Inspect(), second.Inspect(), opened)
	}
	second.Script("s").Stop("done")
	if _, err := second.Pump(time.Unix(0, 0), PumpOptions{}); err != nil || len(opened[second]) != 0 {
		t.Fatal(err, opened)
	}
}

func TestScopeAutomaticContractsAndDisabledReload(t *testing.T) {
	for _, contract := range []string{"charge", "answer", "fail", "malformed", "panic", "declared error"} {
		t.Run(contract, func(t *testing.T) {
			c := New()
			closed := 0
			d, err := c.DefineCapability("resource",
				Operation{Name: "open", Mode: Immediate, Result: NothingShape, Scope: &ScopeDecl{Opens: "file", Abandon: "close"}, Do: func(*Call, []Value) (Value, error) { return Nothing, nil }},
				Operation{Name: "close", Mode: Immediate, Result: NothingShape, Errors: []ErrorDecl{{Code: "broken"}}, Scope: &ScopeDecl{Closes: "file"}, Do: func(call *Call, _ []Value) (Value, error) {
					closed++
					switch contract {
					case "charge":
						_ = call.Charge(1) // ignored contract failure still fails abandonment
					case "answer", "fail":
						func() {
							defer func() { _ = recover() }()
							if contract == "answer" {
								call.Answer(Nothing)
							} else {
								call.Fail(nil)
							}
						}()
					case "malformed":
						return Int(7), nil
					case "panic":
						panic("broken Host")
					case "declared error":
						return Nothing, &ScriptError{Code: "broken"}
					}
					return Nothing, nil
				}})
			if err != nil {
				t.Fatal(err)
			}
			g := c.NewGroup(GroupOptions{})
			source := "on go\n ask r to open\nend go\n"
			s, err := g.Load(LoadOptions{Name: "s", Source: source, Grants: map[string]*Grant{"r": d.GrantAll(nil)}})
			if err != nil {
				t.Fatal(err)
			}
			_, p, err := s.Request(nil, Message{Name: "go"})
			if err != nil {
				t.Fatal(err)
			}
			now := time.Unix(1, 0)
			r, err := g.Pump(now, PumpOptions{})
			_, failure := p.Result()
			if err != nil || failure != nil || len(r.Reports) != 2 || closed != 1 {
				t.Fatal(r, err, failure, closed)
			}
			effect, ok := r.Reports[0].(*EffectFailure)
			status := EffectUnknown
			if contract == "declared error" {
				status = EffectFailed
			}
			if !ok || effect.Status != status || effect.Phase != "abandon" || effect.Scope != "file" {
				t.Fatal(r.Reports)
			}
			if !slices.Equal(g.Inspect().Scripts[0].DisabledGrants, []string{"r"}) {
				t.Fatal(g.Inspect())
			}
			s.Revoke("r")
			if _, err := g.Pump(now, PumpOptions{}); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Reload(source, CarryVariables); err != nil {
				t.Fatal(err)
			}
			_, p, err = s.Request(nil, Message{Name: "go"})
			if err != nil {
				t.Fatal(err)
			}
			r, err = g.Pump(now, PumpOptions{})
			_, failure = p.Result()
			if err != nil || failure == nil || failure.Data.String() == "nothing" || r.FuelUsed != 8 || closed != 1 {
				t.Fatal(r, err, failure, closed)
			}
			if end := r.Reports[0].(*RunEnd); end.Error.Code != "capability disabled" {
				t.Fatal(end)
			}
		})
	}
}

func TestScopeReloadValidatesBeforeAbandonment(t *testing.T) {
	c := New()
	closed := 0
	now := time.Unix(12, 0)
	d, err := c.DefineCapability("resource",
		Operation{Name: "open", Mode: Immediate, Result: NothingShape, Scope: &ScopeDecl{Opens: "file", Abandon: "close"}, Do: func(*Call, []Value) (Value, error) { return Nothing, nil }},
		Operation{Name: "close", Mode: Immediate, Result: NothingShape, Scope: &ScopeDecl{Closes: "file"}, Do: func(call *Call, _ []Value) (Value, error) {
			closed++
			if !call.Now().Equal(now) {
				t.Fatal(call.Now())
			}
			_, err := call.Group().Script(call.ScriptName()).Reload("on go\n return\nend go\n", ResetVariables)
			var host *HostError
			if !errors.As(err, &host) || host.Code != ReentrantCall {
				t.Fatal(err)
			}
			return Nothing, nil
		}})
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	source := "script variable n=0\non go\n ask r to open\n put 9 into n\n repeat forever\n end repeat\nend go\n"
	s, err := g.Load(LoadOptions{Name: "s", Source: source, GrantsAsUsed: true, Grants: map[string]*Grant{"r": d.GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(s.Grants()["r"], []string{"close", "open"}) {
		t.Fatal(s.Grants())
	}
	if _, err := s.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(now, PumpOptions{FuelSlice: 40}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reload("on", CarryVariables); err == nil || closed != 0 {
		t.Fatal(err, closed)
	}
	if _, err := s.Reload(source, CarryVariables); err != nil || closed != 1 || g.Inspect().Scripts[0].Vars[0].Val.String() != "0" {
		t.Fatal(err, closed, g.Inspect())
	}
}

func TestScopeGuardPaysLocalHandlerDispatch(t *testing.T) {
	c := New()
	d, err := c.DefineCapability("resource",
		Operation{Name: "open", Mode: Immediate, Result: NothingShape, Scope: &ScopeDecl{Opens: "file", Abandon: "close"}, Do: func(*Call, []Value) (Value, error) { return Nothing, nil }},
		Operation{Name: "close", Mode: Immediate, Result: NothingShape, Scope: &ScopeDecl{Closes: "file"}, Do: func(*Call, []Value) (Value, error) { return Nothing, nil }})
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Grants: map[string]*Grant{"r": d.GrantAll(nil)}, Source: "on go\n ask r to open\n helper and wait\nend go\non helper\n wait for ping\nend helper\n"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	// 4 outer dispatch + 11 acquisition/conversion + 1 drop + 8 local
	// call + 4 helper dispatch + 8 unwind. The guarded wait costs nothing.
	if err != nil || r.FuelUsed != 36 || len(r.Reports) != 1 || r.Reports[0].(*RunEnd).Error.Code != "scope open" {
		t.Fatal(r, err)
	}
}

func TestScopeStopAcknowledgesAcquisitionBeforeCleanup(t *testing.T) {
	c := New()
	var opened, abandoned *Call
	d, err := c.DefineCapability("resource",
		Operation{Name: "open", Mode: Immediate, Result: NothingShape, Scope: &ScopeDecl{Opens: "file", Abandon: "close"}, Do: func(call *Call, _ []Value) (Value, error) {
			opened = call
			call.Group().Script(call.ScriptName()).Stop("done")
			return Nothing, nil
		}},
		Operation{Name: "close", Mode: Immediate, Result: NothingShape, Cost: Cost{Fuel: 1000, Alloc: 1000}, Scope: &ScopeDecl{Closes: "file"}, Do: func(call *Call, args []Value) (Value, error) {
			abandoned = call
			if len(args) != 0 || call.Context().Err() != nil {
				t.Fatal(args, call.Context().Err())
			}
			return Nothing, nil
		}})
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Grants: map[string]*Grant{"r": d.GrantAll("binding")}, Source: "on go\n ask r to open\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	r, err := g.Pump(time.Unix(0, 0), PumpOptions{})
	if err != nil || r.State != Stopped || len(r.Reports) != 1 || opened == nil || abandoned == nil {
		t.Fatal(r, err, opened, abandoned)
	}
	if opened.Automatic() || !abandoned.Automatic() || opened.ScopeName() != "file" || abandoned.ScopeName() != "file" || abandoned.ID() == opened.ID() || abandoned.RunID() != opened.RunID() || abandoned.SegmentID() != opened.SegmentID() || abandoned.Binding() != "binding" || s.Counters().AllocTotal != 0 {
		t.Fatal(opened, abandoned, s.Counters())
	}
}
