package northtalk

import (
	"context"
	"testing"
	"time"
)

func TestMessagePathOwnerAndFixedTarget(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	kind := objectKindForTest(t, c, "room")
	parent, _ := g.Object(kind, "parent", nil)
	leaf, _ := g.Object(kind, "leaf", nil)
	_, err := g.Load(LoadOptions{Name: "parent", Owner: parent, Source: "on ping\n  return [the id of me, the id of the target]\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	setter, ok := any(g).(interface{ SetParent(*Object, *Object) error })
	if !ok {
		t.Fatal("SetParent is missing")
	}
	if err := setter.SetParent(leaf, parent); err != nil {
		t.Fatal(err)
	}
	_, p, err := g.Request(context.Background(), leaf, Message{Name: "ping"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.Done():
	default:
		t.Fatal("request did not settle")
	}
	answer, failure := p.Result()
	if failure != nil || answer.String() != `["parent", "leaf"]` {
		t.Fatal(answer, failure, result)
	}
}

func TestMessagePathUnownedObjectCostsNoFuel(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	o, _ := g.Object(objectKindForTest(t, c, "room"), "orphan", nil)
	id, p, err := g.Request(context.Background(), o, Message{Name: "missing"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if result.FuelUsed != 0 || len(operationalReports(result.Reports)) != 1 {
		t.Fatal(result)
	}
	u, ok := operationalReports(result.Reports)[0].(*Unhandled)
	if !ok || u.Delivery != id || u.Target != o {
		t.Fatal(operationalReports(result.Reports))
	}
	select {
	case <-p.Done():
	default:
		t.Fatal("unhandled request not settled")
	}
	_, failure := p.Result()
	if failure == nil || failure.Code != "send failed" {
		t.Fatal(failure)
	}
}

func TestMessagePathParentChangesRejectCyclesInInputOrder(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	k := objectKindForTest(t, c, "room")
	a, _ := g.Object(k, "a", nil)
	b, _ := g.Object(k, "b", nil)
	if err := g.SetParent(a, b); err != nil {
		t.Fatal(err)
	}
	if err := g.SetParent(b, a); err != nil {
		t.Fatal(err)
	} // unknown until the queue drains
	result, err := g.Pump(time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC), PumpOptions{})
	if err != nil || len(operationalReports(result.Reports)) != 1 {
		t.Fatal(result, err)
	}
	e, ok := operationalReports(result.Reports)[0].(*HostError)
	if !ok || e.Code != ParentCycle {
		t.Fatal(operationalReports(result.Reports))
	}
	hostCode(t, g.SetParent(b, a), ParentCycle)
	hostCode(t, g.SetParent(a, a), ParentCycle)
	if err := g.SetParent(a, nil); err != nil {
		t.Fatal(err)
	}
}

func TestMessagePathUnhandledRunKeepsDecisionOpenForParent(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	k := objectKindForTest(t, c, "room")
	a, _ := g.Object(k, "a", nil)
	b, _ := g.Object(k, "b", nil)
	_, err := g.Load(LoadOptions{Name: "child", Owner: a, Source: "on other\nend other"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = g.Load(LoadOptions{Name: "parent", Owner: b, Source: "on ping, deciding\n  veto \"no\"\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	if err := g.SetParent(a, b); err != nil {
		t.Fatal(err)
	}
	_, d, err := g.Decide(context.Background(), a, Message{Name: "ping"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if answer := d.Decided(); answer == nil || answer.Verdict != Vetoed || answer.Vetoes[0].Script != "parent" {
		t.Fatal(answer, result)
	}
}

func TestMessagePathWaitingSendsReplyFromAncestorOrFailAtEnd(t *testing.T) {
	for _, source := range []string{
		"on go\n  send ping to child and wait\n  return it\nend go",
		"on go\n  ping and wait\n  return it\nend go",
	} {
		for _, owned := range []bool{true, false} {
			t.Run(source+map[bool]string{true: "owned", false: "orphan"}[owned], func(t *testing.T) {
				c := New()
				g := c.NewGroup(GroupOptions{})
				k := objectKindForTest(t, c, "room")
				a, _ := g.Object(k, "a", nil)
				b, _ := g.Object(k, "b", nil)
				sender, err := g.Load(LoadOptions{Name: "sender", Owner: a, Objects: map[string]*Object{"child": a}, Source: source})
				if err != nil {
					t.Fatal(err)
				}
				if owned {
					_, err = g.Load(LoadOptions{Name: "parent", Owner: b, Source: "on ping\n  return the id of the target\nend ping"})
					if err != nil {
						t.Fatal(err)
					}
					if err := g.SetParent(a, b); err != nil {
						t.Fatal(err)
					}
				}
				_, p, err := sender.Request(context.Background(), Message{Name: "go"})
				if err != nil {
					t.Fatal(err)
				}
				result, err := g.Pump(time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC), PumpOptions{})
				if err != nil {
					t.Fatal(err)
				}
				select {
				case <-p.Done():
				default:
					t.Fatal("request still pending", result)
				}
				answer, failure := p.Result()
				if owned {
					if failure != nil || answer.String() != `"a"` {
						t.Fatal(answer, failure, result)
					}
				} else {
					if failure == nil {
						t.Fatal(answer, result)
					}
				}
			})
		}
	}
}

func TestMessagePathOwnerDisposalStopsRunAndSkipsQueuedTarget(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	k := objectKindForTest(t, c, "room")
	a, _ := g.Object(k, "a", nil)
	b, _ := g.Object(k, "b", nil)
	child, err := g.Load(LoadOptions{Name: "child", Owner: a, Source: "on hold\n  wait 1s\nend hold\non ping\n  return \"child\"\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = g.Load(LoadOptions{Name: "parent", Owner: b, Source: "on ping\n  return [the id of me, the id of the target]\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	if err := g.SetParent(a, b); err != nil {
		t.Fatal(err)
	}
	_, held, err := child.Request(context.Background(), Message{Name: "hold"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC)
	if _, err := g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	_, queued, err := g.Request(context.Background(), a, Message{Name: "ping"})
	if err != nil {
		t.Fatal(err)
	}
	if err := g.Dispose(a); err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(now, PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	_, failure := held.Result()
	if failure == nil || failure.Data.String() != `{reason: "stopped"}` {
		t.Fatal(failure, result)
	}
	answer, failure := queued.Result()
	if failure != nil || answer.String() != `["b", "a"]` {
		t.Fatal(answer, failure, result)
	}
	stops := 0
	for _, r := range operationalReports(result.Reports) {
		if s, ok := r.(*Stop); ok && s.Reason == "owner disposed" {
			stops++
		}
	}
	if stops != 1 {
		t.Fatal(operationalReports(result.Reports))
	}
	hostCode(t, g.SetParent(a, nil), InvalidValue)
	if err := g.Dispose(a); err != nil {
		t.Fatal(err)
	}
	again, err := g.Pump(now, PumpOptions{})
	if err != nil || len(operationalReports(again.Reports)) != 0 {
		t.Fatal(again, err)
	}
}

func TestMessagePathCancellationFollowsMovedMailbox(t *testing.T) {
	c := New()
	ready := make(chan struct{}, 16)
	g := c.NewGroup(GroupOptions{OnReady: func() { ready <- struct{}{} }})
	k := objectKindForTest(t, c, "room")
	a, _ := g.Object(k, "a", nil)
	b, _ := g.Object(k, "b", nil)
	leaf, _ := g.Object(k, "leaf", nil)
	_, err := g.Load(LoadOptions{Name: "old", Owner: a, Source: "on ping\n  return 1\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	next, err := g.Load(LoadOptions{Name: "next", Owner: b, Source: "on hold\n  repeat 20 times\n  end repeat\nend hold\non ping\n  return 2\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC)
	if err := g.SetParent(leaf, a); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := next.Deliver(Message{Name: "hold"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	id, p, err := g.Request(ctx, leaf, Message{Name: "ping"})
	if err != nil {
		t.Fatal(err)
	}
	if err := g.SetParent(leaf, b); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(now, PumpOptions{FuelCap: 1}); err != nil {
		t.Fatal(err)
	}
drainReady:
	for {
		select {
		case <-ready:
		default:
			break drainReady
		}
	}
	cancel()
	select {
	case <-ready:
	case <-time.After(time.Second):
		t.Fatal("context cancellation was not queued")
	}
	result, err := g.Pump(now, PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.Done():
	default:
		t.Fatal("cancellation not settled", result)
	}
	_, failure := p.Result()
	if failure == nil || failure.Data.String() != `{reason: "cancelled"}` {
		t.Fatal(failure, result)
	}
	for _, report := range operationalReports(result.Reports) {
		if end, ok := report.(*RunEnd); ok && end.Delivery == id && (end.Run != "" || end.Script != "next" || end.Outcome != Cancelled) {
			t.Fatal(end)
		}
	}
}

func TestMessagePathClimbFullEndsRequestWithTarget(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	k := objectKindForTest(t, c, "room")
	a, _ := g.Object(k, "a", nil)
	b, _ := g.Object(k, "b", nil)
	child, err := g.Load(LoadOptions{Name: "child", Owner: a, Source: "on ping\n  pass ping\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	parent, err := g.Load(LoadOptions{Name: "parent", Owner: b, Limits: Limits{MailboxDepth: 1}, Source: "on ping\n  return 1\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	if err := g.SetParent(a, b); err != nil {
		t.Fatal(err)
	}
	_, p, err := child.Request(context.Background(), Message{Name: "ping"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parent.Deliver(Message{Name: "ping"}); err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	_, failure := p.Result()
	if failure == nil || failure.Data.String() != `{reason: "unhandled"}` {
		t.Fatal(failure, result)
	}
	unhandled := 0
	for _, report := range operationalReports(result.Reports) {
		if u, ok := report.(*Unhandled); ok {
			unhandled++
			if u.Target != a {
				t.Fatal(u)
			}
		}
	}
	if unhandled != 1 {
		t.Fatal(operationalReports(result.Reports))
	}
}

func TestMessagePathReceivingLimitsCapHostOverride(t *testing.T) {
	for _, climb := range []bool{false, true} {
		t.Run(map[bool]string{false: "move", true: "climb"}[climb], func(t *testing.T) {
			c := New()
			g := c.NewGroup(GroupOptions{})
			k := objectKindForTest(t, c, "room")
			a, _ := g.Object(k, "a", nil)
			b, _ := g.Object(k, "b", nil)
			leaf, _ := g.Object(k, "leaf", nil)
			_, err := g.Load(LoadOptions{Name: "old", Owner: a, Limits: Limits{FuelPerRun: 1000}, Source: "on ping\n  pass ping\nend ping"})
			if err != nil {
				t.Fatal(err)
			}
			_, err = g.Load(LoadOptions{Name: "next", Owner: b, Limits: Limits{FuelPerRun: 10}, Source: "on ping\n  repeat 20 times\n  end repeat\nend ping"})
			if err != nil {
				t.Fatal(err)
			}
			now := time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC)
			if err := g.SetParent(leaf, a); err != nil {
				t.Fatal(err)
			}
			if climb {
				if err := g.SetParent(a, b); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := g.Pump(now, PumpOptions{}); err != nil {
				t.Fatal(err)
			}
			_, p, err := g.Request(context.Background(), leaf, Message{Name: "ping", Limits: &LimitOverride{FuelPerRun: 500}})
			if err != nil {
				t.Fatal(err)
			}
			if !climb {
				if err := g.SetParent(leaf, b); err != nil {
					t.Fatal(err)
				}
			}
			result, err := g.Pump(now, PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			_, failure := p.Result()
			if failure == nil || failure.Data.String() != `{reason: "limit fault"}` {
				t.Fatal(failure, result)
			}
			faults := 0
			for _, report := range operationalReports(result.Reports) {
				if end, ok := report.(*RunEnd); ok && end.Script == "next" {
					if end.Outcome != LimitFault || end.Fuel > 10 {
						t.Fatal(end)
					}
					faults++
				}
			}
			if faults != 1 {
				t.Fatal(operationalReports(result.Reports))
			}
		})
	}
}

func TestMessagePathOwnerLoadIsAtomicAndChecksMeProperties(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	kind, err := c.DefineObjectKind(ObjectKindDef{Name: "lamp", Props: []Prop{{Name: "name", Shape: TextShape, Get: func(*Object) (Value, error) { return mustPublicText("lamp"), nil }}}})
	if err != nil {
		t.Fatal(err)
	}
	o, _ := g.Object(kind, "lamp", nil)
	_, err = g.Load(LoadOptions{Name: "bad", Owner: o, Source: "on go\n set the name of me to \"x\"\nend go"})
	load, ok := err.(*LoadError)
	if !ok || load.Diagnostics[0].Code != "can't write" {
		t.Fatal(err)
	}
	_, err = g.Load(LoadOptions{Name: "good", Owner: o, Source: "on go\n return me\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = g.Load(LoadOptions{Name: "duplicate", Owner: o, Source: "on go\nend go"})
	hostCode(t, err, InvalidValue)
}

func TestMessagePathDisposedOwnerRemainsStopped(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	o, _ := g.Object(objectKindForTest(t, c, "room"), "owner", nil)
	s, err := g.Load(LoadOptions{Name: "s", Owner: o, Source: "on ping\n return 42\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC)
	for _, alreadyDisposed := range []bool{false, true} {
		if !alreadyDisposed {
			if err := g.Dispose(o); err != nil {
				t.Fatal(err)
			}
		}
		_, p, err := s.Request(context.Background(), Message{Name: "ping"})
		if err != nil {
			t.Fatal(err)
		}
		result, err := g.Pump(now, PumpOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if result.State != Stopped || result.FuelUsed != 0 {
			t.Fatal(result)
		}
		_, failure := p.Result()
		if failure == nil || failure.Data.String() != `{reason: "stopped"}` {
			t.Fatal(failure, result)
		}
		for _, r := range operationalReports(result.Reports) {
			if _, ok := r.(*RunEnd); ok {
				t.Fatal("disposed owner ran", r)
			}
		}
	}
}

func TestMessagePathInternalErrorKeepsOwnerTarget(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	o, _ := g.Object(objectKindForTest(t, c, "room"), "owner", nil)
	s, err := g.Load(LoadOptions{Name: "s", Owner: o, Source: "on ping\n throw {code: \"boom\"}\nend ping\non error e\n return the target\nend error"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Deliver(Message{Name: "ping"}); err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range operationalReports(result.Reports) {
		if end, ok := r.(*RunEnd); ok && end.Handler == "error" {
			if !end.Result.Equal(o.Value()) {
				t.Fatal(end.Result)
			}
			return
		}
	}
	t.Fatal("missing error Run", result)
}

func TestMessagePathInternalErrorObservationUsesOwnerTarget(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	o, _ := g.Object(objectKindForTest(t, c, "room"), "owner", nil)
	s, err := g.Load(LoadOptions{Name: "s", Owner: o, Source: "on watch\n wait for error e from me\n return the code of e\nend watch\non ping\n throw {code: \"boom\"}\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := s.Request(context.Background(), Message{Name: "watch"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Deliver(Message{Name: "ping"}); err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.Done():
	default:
		t.Fatal("error was not observed", result)
	}
	answer, failure := p.Result()
	if failure != nil || answer.String() != `"boom"` {
		t.Fatal(answer, failure, result)
	}
}

func TestMessagePathScriptSendToStoppedReceiver(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	o, _ := g.Object(objectKindForTest(t, c, "room"), "owner", nil)
	_, err := g.Load(LoadOptions{Name: "receiver", Owner: o, Source: "on ping\n return 42\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	sender, err := g.Load(LoadOptions{Name: "sender", Source: "on go\n send ping to receiver and wait\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	if err := g.Dispose(o); err != nil {
		t.Fatal(err)
	}
	_, p, err := sender.Request(context.Background(), Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.Done():
	default:
		t.Fatal("stopped send did not settle", result)
	}
	_, failure := p.Result()
	if failure == nil {
		t.Fatal(result)
	}
	for _, r := range operationalReports(result.Reports) {
		if end, ok := r.(*RunEnd); ok && end.Script == "receiver" {
			t.Fatal(end)
		}
	}
}

func TestMessagePathUnknownCommandFullMailboxNamesReceiver(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	k := objectKindForTest(t, c, "room")
	a, _ := g.Object(k, "a", nil)
	b, _ := g.Object(k, "b", nil)
	child, err := g.Load(LoadOptions{Name: "child", Owner: a, Source: "on go\n try\n  ping\n catch e\n  return the to of e\n end try\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	parent, err := g.Load(LoadOptions{Name: "parent", Owner: b, Limits: Limits{MailboxDepth: 1}, Source: "on ping\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	if err := g.SetParent(a, b); err != nil {
		t.Fatal(err)
	}
	_, p, err := child.Request(context.Background(), Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := parent.Deliver(Message{Name: "ping"}); err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	answer, failure := p.Result()
	if failure != nil || answer.String() != `"parent"` {
		t.Fatal(answer, failure, result)
	}
}

func TestMessagePathReloadRestartsStoppedScriptAddress(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	o, _ := g.Object(objectKindForTest(t, c, "room"), "owner", nil)
	s, err := g.Load(LoadOptions{Name: "s", Owner: o, Source: "on ping\n return 1\nend ping"})
	if err != nil {
		t.Fatal(err)
	}
	if err := g.Dispose(o); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC)
	if _, err := g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reload("on ping\n return 2\nend ping", ResetVariables); err != nil {
		t.Fatal(err)
	}
	_, p, err := s.Request(context.Background(), Message{Name: "ping"})
	if err != nil {
		t.Fatal(err)
	}
	_, object, err := g.Request(context.Background(), o, Message{Name: "ping"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(now, PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	answer, failure := p.Result()
	if failure != nil || answer.String() != "2" || result.State != Idle {
		t.Fatal(answer, failure, result)
	}
	_, failure = object.Result()
	if failure == nil || failure.Data.String() != `{reason: "unhandled"}` {
		t.Fatal(failure, result)
	}
}
