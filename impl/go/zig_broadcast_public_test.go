package northtalk_test

import (
	"errors"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	talk "northtalk.org/go"
)

// Public Hosts share the independently compiled native-Go comparison harness.
func runBroadcastBridgeCases(t *testing.T) []bridgeObservation {
	t.Helper()
	var out []bridgeObservation
	for _, name := range []string{"broadcast late", "broadcast stop", "broadcast empty", "broadcast copies", "broadcast limits", "broadcast zero fuel", "broadcast overrides", "broadcast waiting", "broadcast cancelled wait", "broadcast callback", "broadcast release", "broadcast trace", "broadcast OnReady", "broadcast refusals"} {
		t.Run(name, func(t *testing.T) {
			o := bridgeObservation{Name: name}
			var trace bridgeTrace
			core := talk.New()
			var g *talk.Group
			var enabled, notified atomic.Bool
			broadcastMessage := func(m talk.Message) {
				id, err := g.Broadcast(m)
				if err != nil {
					t.Fatal(err)
				}
				o.Values = append(o.Values, string(id))
			}
			broadcast := func() { broadcastMessage(talk.Message{Name: "hello", Args: []talk.Value{talk.Int(7)}}) }
			checkReentry := func() {
				if _, err := g.Pump(bridgeNow, talk.PumpOptions{}); !isReentrant(err) {
					t.Fatal(err)
				}
				if _, err := g.Load(talk.LoadOptions{Name: "nested", Source: ""}); !isReentrant(err) {
					t.Fatal(err)
				}
			}
			g = core.NewGroup(talk.GroupOptions{Name: "g", Trace: &trace, OnReady: func() {
				if name == "broadcast OnReady" && enabled.Load() && notified.CompareAndSwap(false, true) {
					checkReentry()
					broadcast()
				}
			}})
			pump := func(options talk.PumpOptions) {
				r, err := g.Pump(bridgeNow, options)
				if err != nil {
					t.Fatal(err)
				}
				o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(r)))
			}
			load := func(name, source string, limits talk.Limits, grants map[string]*talk.Grant) *talk.Script {
				s, err := g.Load(talk.LoadOptions{Name: name, Source: source, Limits: limits, Grants: grants})
				if err != nil {
					t.Fatal(err)
				}
				return s
			}
			source := "on hello x\n return x\nend hello"
			switch name {
			case "broadcast late", "broadcast copies":
				if name == "broadcast late" {
					load("first", source, talk.Limits{}, nil)
				}
				args := []talk.Value{talk.Int(7)}
				if name == "broadcast copies" {
					args[0] = talk.List(talk.Int(7), talk.Bool(true))
				}
				limits := &talk.LimitOverride{FuelPerRun: 100}
				broadcastMessage(talk.Message{Name: "hello", Args: args, Limits: limits})
				args[0] = talk.Int(99)
				limits.FuelPerRun = 1
				load("late", source, talk.Limits{}, nil)
				load("uninterested", "on other\n return\nend other", talk.Limits{}, nil)
				pump(talk.PumpOptions{})
			case "broadcast empty":
				broadcast()
				pump(talk.PumpOptions{})
				broadcast()
				pump(talk.PumpOptions{})
			case "broadcast waiting", "broadcast cancelled wait":
				s := load("watcher", "on watch\n wait for hello\n return 9\nend watch", talk.Limits{}, nil)
				if _, err := s.Deliver(talk.Message{Name: "watch"}); err != nil {
					t.Fatal(err)
				}
				pump(talk.PumpOptions{})
				if name == "broadcast cancelled wait" {
					s.CancelRun("watcher/r1")
				}
				broadcast()
				pump(talk.PumpOptions{})
			case "broadcast callback", "broadcast release", "broadcast trace", "broadcast OnReady":
				op := talk.Operation{Name: "touch", Result: talk.NothingShape, Do: func(*talk.Call, []talk.Value) (talk.Value, error) {
					if name == "broadcast callback" || name == "broadcast OnReady" {
						enabled.Store(true)
						done := make(chan struct{})
						go func() {
							broadcast()
							if _, err := g.Broadcast(talk.Message{Name: "hello", Limits: &talk.LimitOverride{Set: 1 << 7}}); err == nil {
								t.Error("accepted invalid override in callback")
							}
							close(done)
						}()
						select {
						case <-done:
						case <-time.After(5 * time.Second):
							t.Fatal("Broadcast admission deadlocked")
						}
						checkReentry()
					}
					return talk.Nothing, nil
				}}
				def, err := core.DefineCapability("api", op, talk.WithReleaseHook(func(talk.GrantContext) {
					if name == "broadcast release" {
						broadcast()
						checkReentry()
					}
				}))
				if err != nil {
					t.Fatal(err)
				}
				s := load("sender", "on go\n ask api to touch\nend go", talk.Limits{}, map[string]*talk.Grant{"api": def.GrantAll(nil)})
				target := load("target", source, talk.Limits{}, nil)
				if name == "broadcast trace" {
					trace.record = func(line string) {
						if strings.HasPrefix(line, "call ") && notified.CompareAndSwap(false, true) {
							broadcast()
							checkReentry()
						}
					}
				}
				if name == "broadcast release" {
					s.Stop("release")
				} else if _, err := s.Deliver(talk.Message{Name: "go"}); err != nil {
					t.Fatal(err)
				}
				pump(talk.PumpOptions{})
				if target.Counters().Runs != 0 {
					t.Fatal("callback Broadcast ran in same Pump")
				}
				pump(talk.PumpOptions{})
				want := int64(1)
				if name == "broadcast OnReady" {
					want = 2
				}
				if target.Counters().Runs != want {
					t.Fatal(target.Counters())
				}
			case "broadcast refusals":
				for _, message := range []talk.Message{{Name: "hello:with:"}, {Name: "hello", Limits: &talk.LimitOverride{MaxWait: time.Microsecond}}, {Name: "hello", Limits: &talk.LimitOverride{FuelPerRun: -1}}, {Name: "hello", Limits: &talk.LimitOverride{FuelPerRun: talk.DefaultLimits().FuelPerRun + 1}}, {Name: "hello", Limits: &talk.LimitOverride{Set: 1 << 7}}} {
					_, err := g.Broadcast(message)
					var host *talk.HostError
					if !errors.As(err, &host) {
						t.Fatalf("Broadcast(limits=%+v): %v", message.Limits, err)
					}
					o.Values = append(o.Values, string(host.Code))
				}
				broadcast()
				pump(talk.PumpOptions{})
			default:
				limits := talk.Limits{}
				if name == "broadcast limits" || name == "broadcast overrides" {
					limits.FuelPerRun = 5
				}
				a := load("a", source, limits, nil)
				load("b", source, talk.Limits{}, nil)
				if name == "broadcast stop" {
					a.Stop("prior")
				}
				m := talk.Message{Name: "hello", Args: []talk.Value{talk.Int(7)}}
				switch name {
				case "broadcast zero fuel":
					m.Limits = &talk.LimitOverride{Set: talk.OverrideFuelPerRun}
				case "broadcast overrides":
					m.Limits = &talk.LimitOverride{FuelPerRun: 100, AllocPerRun: 100, MaxWait: time.Millisecond, MaxJoin: 2}
				}
				broadcastMessage(m)
				pump(talk.PumpOptions{FuelSlice: 6})
				pump(talk.PumpOptions{})
			}
			o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(g.Inspect())))
			o.Trace = append([]string{}, trace.lines...)
			out = append(out, o)
		})
	}
	return out
}
