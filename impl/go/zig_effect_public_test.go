package northtalk_test

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	talk "northtalk.org/go"
)

// Both independently compiled public Hosts observe lifecycle ownership,
// provisional writes, futures, inspection, typed Reports and exact Trace.
func runEffectBridgeCases(t *testing.T) []bridgeObservation {
	var observations []bridgeObservation
	for _, name := range []string{"complete", "explicit close", "scope guard", "ordinary error", "preempt stop", "preempt cancel", "reload", "begin failed", "begin unknown", "commit failed", "commit unknown", "rollback failed", "abandon shape", "abandon declared", "abandon Host error", "abandon panic", "abandon charge", "conflict"} {
		t.Run("effects "+name, func(t *testing.T) {
			o := bridgeObservation{Name: "effects " + name}
			var trace bridgeTrace
			core := talk.New()
			g := core.NewGroup(talk.GroupOptions{Trace: &trace})
			staged, published := 0, 0
			lifecycle := &talk.SegmentLifecycle{}
			hook := func(phase string) func(talk.SegmentContext) talk.EffectResult {
				return func(c talk.SegmentContext) talk.EffectResult {
					if c.Group != g || c.ScriptName != "s" || c.GrantName != "a" || c.Binding != "a-binding" || !c.Now.Equal(bridgeNow) {
						t.Fatalf("wrong Segment context: %+v", c)
					}
					members := []string{}
					for _, grant := range c.Grants {
						members = append(members, fmt.Sprintf("%s=%v", grant.GrantName, grant.Binding))
					}
					o.Calls = append(o.Calls, phase+":"+c.SegmentID+":"+strings.Join(members, ","))
					status := talk.EffectOK
					if name == phase+" failed" {
						status = talk.EffectFailed
					}
					if name == phase+" unknown" {
						status = talk.EffectUnknown
					}
					if phase == "commit" && status == talk.EffectOK {
						published += staged
						staged = 0
					}
					if phase == "rollback" {
						staged = 0
					}
					return talk.EffectResult{Status: status, Detail: "private lifecycle detail"}
				}
			}
			lifecycle.Begin, lifecycle.Commit, lifecycle.Rollback = hook("begin"), hook("commit"), hook("rollback")
			operations := func(bound bool) []talk.CapabilityOption {
				return []talk.CapabilityOption{
					talk.Operation{Name: "open", Mode: talk.Immediate, SegmentBound: bound, Result: talk.NothingShape, Scope: &talk.ScopeDecl{Opens: "resource", Abandon: "close"}, Cost: talk.Cost{Fuel: 7, Alloc: 3}, Do: func(c *talk.Call, _ []talk.Value) (talk.Value, error) {
						if c.Automatic() || c.ScopeName() != "resource" {
							t.Fatal("wrong opener context")
						}
						o.Calls = append(o.Calls, fmt.Sprintf("open:%s:%s:%v", c.ID(), c.GrantName(), c.Binding()))
						if bound {
							staged++
						}
						return talk.Nothing, nil
					}},
					talk.Operation{Name: "close", Mode: talk.Immediate, SegmentBound: bound, Result: talk.NothingShape, Scope: &talk.ScopeDecl{Closes: "resource"}, Errors: []talk.ErrorDecl{{Code: "broken"}}, Cost: talk.Cost{Fuel: 900, Alloc: 900}, Do: func(c *talk.Call, args []talk.Value) (talk.Value, error) {
						if len(args) != 0 || c.ScopeName() != "resource" || c.Context().Err() != nil {
							t.Fatal("wrong closer context")
						}
						o.Calls = append(o.Calls, fmt.Sprintf("close:%s:%s:%v:%t", c.ID(), c.GrantName(), c.Binding(), c.Automatic()))
						if c.Automatic() && c.GrantName() == "b" {
							switch name {
							case "abandon shape":
								return talk.Int(7), nil
							case "abandon declared":
								return talk.Nothing, &talk.ScriptError{Code: "broken"}
							case "abandon Host error":
								return talk.Nothing, errors.New("private cleanup failure")
							case "abandon panic":
								panic("private cleanup panic")
							case "abandon charge":
								_ = c.Charge(1)
							}
						}
						return talk.Nothing, nil
					}},
				}
			}
			d, err := core.DefineCoordinatedCapability("resource", func(any) *talk.SegmentLifecycle { return lifecycle }, operations(true)...)
			if err != nil {
				t.Fatal(err)
			}
			u, err := core.DefineCapability("unrelated", operations(false)...)
			if err != nil {
				t.Fatal(err)
			}
			b := d.GrantAll("b-binding")
			if name == "conflict" {
				other := *lifecycle
				different, err := core.DefineCoordinatedCapability("resource", func(any) *talk.SegmentLifecycle { return &other }, operations(true)...)
				if err != nil {
					t.Fatal(err)
				}
				b = different.GrantAll("b-binding")
			}
			body := "ask a to open\nask u to open\nask b to open\nput 9 into n\n"
			switch name {
			case "explicit close":
				body += "ask a to close\nask b to close\nask u to close\n"
			case "scope guard":
				body += "wait 0 ms\n"
			case "ordinary error":
				body += "throw {code: \"ordinary\"}\n"
			case "preempt stop", "preempt cancel", "reload", "rollback failed":
				body += "repeat forever\nend repeat\n"
			}
			source := "script variable n=0\non go\ntry\n" + body + "finally\nput 11 into n\nend try\nreturn n\nend go\n"
			fatal := strings.Contains(name, "unknown") || name == "rollback failed"
			var peers []*talk.Pending
			peer := func(name string) {
				script, err := g.Load(talk.LoadOptions{Name: name, Source: "on go\nwait 1 s\nend go"})
				if err != nil {
					t.Fatal(err)
				}
				_, p, err := script.Request(nil, talk.Message{Name: "go"})
				if err != nil {
					t.Fatal(err)
				}
				peers = append(peers, p)
			}
			if fatal {
				peer("before")
			}
			s, err := g.Load(talk.LoadOptions{Name: "s", Source: source, GrantsAsUsed: true, Grants: map[string]*talk.Grant{"a": d.GrantAll("a-binding"), "b": b, "u": u.GrantAll("u-binding")}})
			if err != nil {
				t.Fatal(err)
			}
			id, p, err := s.Request(nil, talk.Message{Name: "go"})
			if err != nil {
				t.Fatal(err)
			}
			if fatal {
				peer("after")
			}
			pump := func(slice int64) {
				r, err := g.Pump(bridgeNow, talk.PumpOptions{FuelSlice: slice})
				if err != nil {
					t.Fatal(err)
				}
				for _, report := range r.Reports {
					if e, ok := report.(*talk.EffectFailure); ok && e.Detail == "" {
						t.Fatal("missing Host-only effect detail", e)
					}
				}
				o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(r)), bridgeCanonical(reflect.ValueOf(g.Inspect())))
			}
			if strings.HasPrefix(name, "preempt") || name == "reload" || name == "rollback failed" {
				pump(100)
				switch name {
				case "preempt cancel":
					s.CancelRun(talk.RunID("s/r1"))
				case "reload":
					reports, err := s.Reload(source, talk.CarryVariables)
					if err != nil {
						t.Fatal(err)
					}
					o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(reports)))
				default:
					s.Stop("done")
				}
			}
			pump(0)
			select {
			case <-p.Done():
			default:
				t.Fatalf("delivery %s did not settle", id)
			}
			v, failure := p.Result()
			o.Values = append(o.Values, v.String(), fmt.Sprint(bridgeCanonical(reflect.ValueOf(failure))), fmt.Sprintf("staged=%d,published=%d", staged, published))
			for _, p := range peers {
				select {
				case <-p.Done():
				default:
					t.Fatal("fatal effect left another Script running")
				}
				v, e := p.Result()
				o.Values = append(o.Values, v.String(), fmt.Sprint(bridgeCanonical(reflect.ValueOf(e))))
			}
			if fatal {
				_, err := s.Reload(source, talk.CarryVariables)
				var host *talk.HostError
				if !errors.As(err, &host) || host.Code != talk.EffectStateUnknown {
					t.Fatal("fatal Group accepted Reload", err)
				}
			}
			o.Trace = append([]string{}, trace.lines...)
			observations = append(observations, o)
		})
	}
	return observations
}
