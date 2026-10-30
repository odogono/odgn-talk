package northtalk_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	talk "northtalk.org/go"
)

// Decisions use the shared native-Go comparison harness. Each future's
// settlement is observed after every Pump, since it seals before the Run ends.
func runDecideBridgeCases(t *testing.T) []bridgeObservation {
	t.Helper()
	var out []bridgeObservation
	for _, name := range []string{"decide allowed", "decide vetoed", "decide finally", "decide errored", "decide fuel", "decide unhandled", "decide ordinary clause", "decide first wait", "decide dropping", "decide replacing", "decide stop", "decide cancel queued", "decide cancel preempted", "decide cancel sealed", "decide cancel crossing", "queued refusals", "decide mailbox", "decide broadcast", "decide broadcast empty", "decide broadcast slices", "decide broadcast cancel", "decide broadcast cancel sealed", "decide broadcast refusals", "decide callback", "decide release", "decide trace", "decide OnReady"} {
		t.Run(name, func(t *testing.T) {
			o := bridgeObservation{Name: name}
			var trace bridgeTrace
			core := talk.New()
			var g *talk.Group
			var enabled, notified atomic.Bool
			var futures []*talk.Deciding
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			// Context cancellation queues from its own goroutine. Wait for its
			// OnReady, or record that a sealed Verdict queued nothing.
			readied := make(chan struct{}, 64)
			cancelQueued := func(wait time.Duration) string {
				for len(readied) > 0 {
					<-readied
				}
				cancel()
				select {
				case <-readied:
					return "cancel queued"
				case <-time.After(wait):
					return "cancel ignored"
				}
			}
			observe := func() {
				for i, f := range futures {
					select {
					case <-f.Done():
						data, err := json.Marshal(bridgeCanonical(reflect.ValueOf(f.Decided())))
						if err != nil {
							t.Fatal(err)
						}
						o.Values = append(o.Values, string(data))
					default:
						if f.Decided() != nil {
							t.Fatalf("future %d exposes a Verdict before Done", i)
						}
						o.Values = append(o.Values, "open")
					}
				}
			}
			keep := func(id string, f *talk.Deciding, err error) {
				if err != nil {
					t.Fatal(err)
				}
				o.Values = append(o.Values, id)
				futures = append(futures, f)
			}
			decideBroadcast := func() {
				id, f, err := g.DecideBroadcast(ctx, talk.Message{Name: "enter", Args: []talk.Value{talk.Int(7)}})
				keep(string(id), f, err)
			}
			checkReentry := func() {
				if _, err := g.Pump(bridgeNow, talk.PumpOptions{}); !isReentrant(err) {
					t.Fatal(err)
				}
				if _, err := g.Load(talk.LoadOptions{Name: "nested", Source: ""}); !isReentrant(err) {
					t.Fatal(err)
				}
			}
			g = core.NewGroup(talk.GroupOptions{Name: "g", Trace: &trace, OnReady: func() {
				select {
				case readied <- struct{}{}:
				default:
				}
				if name == "decide OnReady" && enabled.Load() && notified.CompareAndSwap(false, true) {
					checkReentry()
					decideBroadcast()
				}
			}})
			pump := func(at time.Time, options talk.PumpOptions) {
				r, err := g.Pump(at, options)
				if err != nil {
					t.Fatal(err)
				}
				o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(r)))
				observe()
			}
			load := func(name, source string, limits talk.Limits, grants map[string]*talk.Grant) *talk.Script {
				s, err := g.Load(talk.LoadOptions{Name: name, Source: source, Limits: limits, Grants: grants})
				if err != nil {
					t.Fatal(err)
				}
				return s
			}
			decide := func(s *talk.Script, c context.Context, m talk.Message) {
				id, f, err := s.Decide(c, m)
				keep(string(id), f, err)
			}
			refused := func(err error) {
				var host *talk.HostError
				if !errors.As(err, &host) {
					t.Fatal(err)
				}
				o.Values = append(o.Values, string(host.Code))
			}
			loop := "script variable n = 0\non enter x, deciding\n try\n  put x into n\n  repeat forever\n  end repeat\n finally\n  put 9 into n\n end try\nend enter"
			switch name {
			case "decide allowed", "decide vetoed", "decide finally", "decide errored", "decide fuel", "decide unhandled", "decide ordinary clause":
				body := map[string]string{
					"decide allowed":         "on enter x, deciding\n return x + 1\nend enter",
					"decide vetoed":          "on enter x, deciding\n veto {reason: \"locked\", at: x}\nend enter",
					"decide finally":         "script variable checked = 0\non enter x, deciding\n try\n  veto \"blocked\"\n finally\n  add 1 to checked\n end try\nend enter",
					"decide errored":         "on enter x, deciding\n return x / 0\nend enter",
					"decide fuel":            "on enter x, deciding\n veto\nend enter",
					"decide unhandled":       "on other\n return\nend other",
					"decide ordinary clause": "on enter x\n return x / 0\nend enter",
				}[name]
				s := load("s", body, talk.Limits{}, nil)
				m := talk.Message{Name: "enter", Args: []talk.Value{talk.Int(7)}}
				if name == "decide fuel" {
					m.Limits = &talk.LimitOverride{FuelPerRun: 4}
				}
				decide(s, nil, m)
				observe()
				pump(bridgeNow, talk.PumpOptions{})
			case "decide first wait":
				s := load("s", "script variable n = 0\non enter x, deciding\n put 1 into n\n wait 1 s\n put 2 into n\nend enter", talk.Limits{}, nil)
				decide(s, ctx, talk.Message{Name: "enter", Args: []talk.Value{talk.Int(7)}})
				pump(bridgeNow, talk.PumpOptions{FuelSlice: 5})
				pump(bridgeNow, talk.PumpOptions{})
				o.Values = append(o.Values, cancelQueued(100*time.Millisecond))
				pump(bridgeNow.Add(time.Second), talk.PumpOptions{})
			case "decide dropping", "decide replacing":
				policy := strings.TrimPrefix(name, "decide ")
				s := load("s", "on enter x, deciding, "+policy+"\n wait 1 s\nend enter", talk.Limits{}, nil)
				decide(s, nil, talk.Message{Name: "enter", Args: []talk.Value{talk.Int(1)}})
				pump(bridgeNow, talk.PumpOptions{})
				decide(s, nil, talk.Message{Name: "enter", Args: []talk.Value{talk.Int(2)}})
				pump(bridgeNow, talk.PumpOptions{})
				pump(bridgeNow.Add(time.Second), talk.PumpOptions{})
			case "decide stop":
				s := load("s", loop, talk.Limits{}, nil)
				decide(s, nil, talk.Message{Name: "enter", Args: []talk.Value{talk.Int(1)}})
				pump(bridgeNow, talk.PumpOptions{FuelSlice: 20})
				decide(s, nil, talk.Message{Name: "enter", Args: []talk.Value{talk.Int(2)}})
				s.Stop("closing")
				pump(bridgeNow, talk.PumpOptions{})
			case "decide cancel queued", "decide cancel preempted":
				s := load("s", loop, talk.Limits{}, nil)
				decide(s, ctx, talk.Message{Name: "enter", Args: []talk.Value{talk.Int(1)}})
				if name == "decide cancel preempted" {
					pump(bridgeNow, talk.PumpOptions{FuelSlice: 20})
				}
				o.Values = append(o.Values, cancelQueued(5*time.Second))
				pump(bridgeNow, talk.PumpOptions{})
			case "decide cancel sealed":
				s := load("s", "on enter x, deciding\n wait 1 s\n return x\nend enter", talk.Limits{}, nil)
				decide(s, ctx, talk.Message{Name: "enter", Args: []talk.Value{talk.Int(1)}})
				pump(bridgeNow, talk.PumpOptions{})
				o.Values = append(o.Values, cancelQueued(100*time.Millisecond))
				pump(bridgeNow.Add(time.Second), talk.PumpOptions{})
			case "decide cancel crossing":
				// The Verdict seals earlier in the same Pump as a crossing that
				// cancels its context; the allowed Run must continue. Zig's
				// future learns of the seal from the Pump's reports, so the
				// adapter queues a cancellation the Core drops, and may notify
				// OnReady where native Go doesn't. Only the Trace is compared.
				op := talk.Operation{Name: "touch", Result: talk.NothingShape, Do: func(*talk.Call, []talk.Value) (talk.Value, error) {
					cancelQueued(100 * time.Millisecond)
					return talk.Nothing, nil
				}}
				def, err := core.DefineCapability("api", op)
				if err != nil {
					t.Fatal(err)
				}
				s := load("s", "on enter x, deciding\n wait 1 s\n return x\nend enter", talk.Limits{}, nil)
				sender := load("sender", "on go\n ask api to touch\nend go", talk.Limits{}, map[string]*talk.Grant{"api": def.GrantAll(nil)})
				decide(s, ctx, talk.Message{Name: "enter", Args: []talk.Value{talk.Int(1)}})
				if _, err := sender.Deliver(talk.Message{Name: "go"}); err != nil {
					t.Fatal(err)
				}
				pump(bridgeNow, talk.PumpOptions{})
				pump(bridgeNow.Add(time.Second), talk.PumpOptions{})
			case "queued refusals":
				// Each refusal writes its input and `refused` records, and
				// consumes no delivery id.
				s := load("s", "on enter x, deciding\n return x\nend enter", talk.Limits{FuelPerRun: 50}, nil)
				for _, m := range []talk.Message{{Name: "enter:with:"}, {Name: "enter", Args: []talk.Value{talk.Int(1)}, Limits: &talk.LimitOverride{FuelPerRun: 51}}, {Name: "enter", Args: []talk.Value{talk.Int(1)}, Limits: &talk.LimitOverride{FuelPerRun: -1}}, {Name: "enter", Args: []talk.Value{talk.Int(1)}, Limits: &talk.LimitOverride{MaxWait: time.Microsecond}}, {Name: "enter", Args: []talk.Value{talk.Int(1)}, Limits: &talk.LimitOverride{Set: 1 << 7}}} {
					_, f, err := s.Decide(nil, m)
					if f != nil {
						t.Fatal("refused Decision returned a future")
					}
					refused(err)
					_, err = s.Deliver(m)
					refused(err)
					_, p, err := s.Request(nil, m)
					if p != nil {
						t.Fatal("refused Request returned a future")
					}
					refused(err)
				}
				decide(s, nil, talk.Message{Name: "enter", Args: []talk.Value{talk.Int(1)}, Limits: &talk.LimitOverride{FuelPerRun: 50}})
				pump(bridgeNow, talk.PumpOptions{})
			case "decide mailbox":
				s := load("s", "on enter x, deciding\n return x\nend enter", talk.Limits{MailboxDepth: 1}, nil)
				decide(s, nil, talk.Message{Name: "enter", Args: []talk.Value{talk.Int(1)}})
				_, f, err := s.Decide(nil, talk.Message{Name: "enter", Args: []talk.Value{talk.Int(2)}})
				if !errors.Is(err, talk.ErrMailboxFull) || f != nil {
					t.Fatal(err)
				}
				o.Values = append(o.Values, "mailbox full")
				pump(bridgeNow, talk.PumpOptions{})
			case "decide broadcast", "decide broadcast slices":
				load("first", "on enter x, deciding\n veto \"first\"\nend enter", talk.Limits{}, nil)
				load("plain", "on enter x\n return x\nend enter", talk.Limits{}, nil)
				load("failing", "on enter x, deciding\n return x / 0\nend enter", talk.Limits{}, nil)
				load("uninterested", "on other\n return\nend other", talk.Limits{}, nil)
				load("second", "on enter x, deciding\n repeat 10 times\n end repeat\n veto [x]\nend enter", talk.Limits{}, nil)
				decideBroadcast()
				options := talk.PumpOptions{}
				if name == "decide broadcast slices" {
					options.FuelSlice = 8
				}
				pump(bridgeNow, options)
				pump(bridgeNow, options)
				pump(bridgeNow, talk.PumpOptions{})
			case "decide broadcast empty":
				decideBroadcast()
				observe()
				pump(bridgeNow, talk.PumpOptions{})
				load("late", "on enter x, deciding\n return x\nend enter", talk.Limits{}, nil)
				decideBroadcast()
				pump(bridgeNow, talk.PumpOptions{})
			case "decide broadcast cancel", "decide broadcast cancel sealed":
				load("quick", "on enter x, deciding\n wait 1 s\nend enter", talk.Limits{}, nil)
				load("slow", loop, talk.Limits{}, nil)
				load("queued", "on enter x, deciding\n return x\nend enter", talk.Limits{}, nil)
				decideBroadcast()
				if name == "decide broadcast cancel sealed" {
					pump(bridgeNow, talk.PumpOptions{FuelSlice: 30})
				}
				o.Values = append(o.Values, cancelQueued(5*time.Second))
				pump(bridgeNow, talk.PumpOptions{})
				pump(bridgeNow.Add(time.Second), talk.PumpOptions{})
			case "decide broadcast refusals":
				for _, m := range []talk.Message{{Name: "enter:with:"}, {Name: "enter", Limits: &talk.LimitOverride{MaxWait: time.Microsecond}}, {Name: "enter", Limits: &talk.LimitOverride{FuelPerRun: -1}}, {Name: "enter", Limits: &talk.LimitOverride{FuelPerRun: talk.DefaultLimits().FuelPerRun + 1}}, {Name: "enter", Limits: &talk.LimitOverride{Set: 1 << 7}}} {
					_, f, err := g.DecideBroadcast(nil, m)
					if f != nil {
						t.Fatal("refused Decision returned a future")
					}
					refused(err)
				}
				decideBroadcast()
				pump(bridgeNow, talk.PumpOptions{})
			case "decide callback", "decide release", "decide trace", "decide OnReady":
				op := talk.Operation{Name: "touch", Result: talk.NothingShape, Do: func(*talk.Call, []talk.Value) (talk.Value, error) {
					if name == "decide callback" || name == "decide OnReady" {
						enabled.Store(true)
						done := make(chan struct{})
						go func() {
							defer close(done)
							decideBroadcast()
							if _, _, err := g.DecideBroadcast(nil, talk.Message{Name: "enter", Limits: &talk.LimitOverride{Set: 1 << 7}}); err == nil {
								t.Error("accepted invalid override in callback")
							}
						}()
						select {
						case <-done:
						case <-time.After(5 * time.Second):
							t.Fatal("Decision admission deadlocked")
						}
						checkReentry()
					}
					return talk.Nothing, nil
				}}
				def, err := core.DefineCapability("api", op, talk.WithReleaseHook(func(talk.GrantContext) {
					if name == "decide release" {
						decideBroadcast()
						checkReentry()
					}
				}))
				if err != nil {
					t.Fatal(err)
				}
				s := load("sender", "on go\n ask api to touch\nend go", talk.Limits{}, map[string]*talk.Grant{"api": def.GrantAll(nil)})
				target := load("target", "on enter x, deciding\n veto x\nend enter", talk.Limits{}, nil)
				if name == "decide trace" {
					trace.record = func(line string) {
						if strings.HasPrefix(line, "call ") && notified.CompareAndSwap(false, true) {
							decideBroadcast()
							checkReentry()
						}
					}
				}
				if name == "decide release" {
					s.Stop("release")
				} else if _, err := s.Deliver(talk.Message{Name: "go"}); err != nil {
					t.Fatal(err)
				}
				pump(bridgeNow, talk.PumpOptions{})
				if target.Counters().Runs != 0 {
					t.Fatal("callback Decision ran in same Pump")
				}
				pump(bridgeNow, talk.PumpOptions{})
			}
			o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(g.Inspect())))
			o.Trace = append([]string{}, trace.lines...)
			out = append(out, o)
		})
	}
	return out
}
