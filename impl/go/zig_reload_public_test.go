package northtalk_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// Reload and Extend use the shared native-Go comparison harness.
func runReloadBridgeCases(t *testing.T) []bridgeObservation {
	t.Helper()
	var out []bridgeObservation
	for _, name := range []string{"reload reset", "reload carry", "reload refusal", "reload state too large", "reload keep mailbox", "reload stopped script", "reload release", "reload stale function", "reload library", "reload reentrant", "extend", "extend refusals", "extend keeps waiting run"} {
		t.Run(name, func(t *testing.T) {
			o := bridgeObservation{Name: name}
			var trace bridgeTrace
			core := talk.New()
			g := core.NewGroup(talk.GroupOptions{Name: "g", Trace: &trace})
			pump := func(at time.Time) {
				r, err := g.Pump(at, talk.PumpOptions{})
				if err != nil {
					t.Fatal(err)
				}
				o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(r)))
			}
			load := func(options talk.LoadOptions) *talk.Script {
				s, err := g.Load(options)
				if err != nil {
					t.Fatal(err)
				}
				return s
			}
			value := func(v any) {
				data, err := json.Marshal(bridgeCanonical(reflect.ValueOf(v)))
				if err != nil {
					t.Fatal(err)
				}
				o.Values = append(o.Values, string(data))
			}
			code := func(err error) {
				var host *talk.HostError
				var load *talk.LoadError
				switch {
				case err == nil:
					o.Values = append(o.Values, "ok")
				case errors.As(err, &host):
					o.Values = append(o.Values, string(host.Code))
				case errors.As(err, &load):
					value(load)
				default:
					t.Fatalf("unexpected error %v", err)
				}
			}
			request := func(s *talk.Script, m string, args ...talk.Value) *talk.Pending {
				_, p, err := s.Request(context.Background(), talk.Message{Name: m, Args: args})
				if err != nil {
					t.Fatal(err)
				}
				return p
			}
			settled := func(p *talk.Pending) {
				select {
				case <-p.Done():
					v, failure := p.Result()
					if v.Kind() == talk.KindFunction {
						v, _ = talk.Text(v.String())
					}
					value([]any{v, failure})
				default:
					o.Values = append(o.Values, "open")
				}
			}
			reload := func(s *talk.Script, source string, carry talk.CarryOver, opts ...talk.ReloadOptions) {
				reports, err := s.Reload(source, carry, opts...)
				code(err)
				value(reports)
			}
			counter := "script variable n = 0\non go\n add 1 to n\n return n\nend go\non hold\n wait 1 s\n return n\nend hold\n"
			switch name {
			case "reload reset", "reload carry":
				s := load(talk.LoadOptions{Name: "s", Source: counter})
				settled0 := request(s, "go")
				held := request(s, "hold")
				pump(bridgeNow)
				settled(settled0)
				carry := talk.ResetVariables
				if name == "reload carry" {
					carry = talk.CarryVariables
				}
				reload(s, "script variable n = 10\nscript variable m = 5\non go\n add 1 to n\n return [n, m]\nend go\n", carry)
				settled(held)
				p := request(s, "go")
				pump(bridgeNow.Add(time.Second))
				settled(p)
			case "reload refusal":
				s := load(talk.LoadOptions{Name: "s", Source: counter})
				reload(s, "on go\n return (\nend go\n", talk.ResetVariables)
				reload(s, "use nothing from nowhere\non go\n return 1\nend go\n", talk.ResetVariables)
				p := request(s, "go")
				pump(bridgeNow)
				settled(p)
			case "reload state too large":
				s := load(talk.LoadOptions{Name: "s", Limits: talk.Limits{PersistentState: 200}, Source: "script variable big = nothing\non grow\n put \"x\" into big\n repeat 7 times\n  put big & big into big\n end repeat\nend grow\n"})
				if _, err := s.Deliver(talk.Message{Name: "grow"}); err != nil {
					t.Fatal(err)
				}
				pump(bridgeNow)
				reload(s, "script variable big = nothing\nscript variable more = \"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy\"\non go\n return big\nend go\n", talk.CarryVariables)
				reload(s, "script variable big = nothing\non go\n return big\nend go\n", talk.CarryVariables)
				p := request(s, "go")
				pump(bridgeNow)
				settled(p)
			case "reload keep mailbox":
				s := load(talk.LoadOptions{Name: "s", Source: counter})
				first := request(s, "go")
				second := request(s, "go")
				pump(bridgeNow) // runs nothing yet: requests land in the drain
				settled(first)
				third := request(s, "go")
				fourth := request(s, "go")
				reload(s, "script variable n = 100\non go\n add 1 to n\n return n\nend go\n", talk.ResetVariables, talk.ReloadOptions{KeepMailbox: true})
				pump(bridgeNow)
				for _, p := range []*talk.Pending{second, third, fourth} {
					settled(p)
				}
				dropped := request(s, "go")
				reload(s, "on go\n return 0\nend go\n", talk.ResetVariables)
				pump(bridgeNow)
				settled(dropped)
			case "reload stopped script":
				s := load(talk.LoadOptions{Name: "s", Source: counter})
				s.Stop("paused")
				pump(bridgeNow)
				p := request(s, "go")
				pump(bridgeNow)
				settled(p)
				reload(s, counter, talk.ResetVariables)
				p = request(s, "go")
				pump(bridgeNow)
				settled(p)
			case "reload release":
				var released []string
				op := talk.Operation{Name: "touch", Result: talk.NothingShape, Do: func(*talk.Call, []talk.Value) (talk.Value, error) { return talk.Nothing, nil }}
				def, err := core.DefineCapability("api", op, talk.WithReleaseHook(func(c talk.GrantContext) {
					released = append(released, c.ScriptName+":"+c.GrantName+":"+string(c.Reason))
				}))
				if err != nil {
					t.Fatal(err)
				}
				s := load(talk.LoadOptions{Name: "s", Grants: map[string]*talk.Grant{"api": def.GrantAll(nil)}, Source: "on go\n ask api to touch\n return 1\nend go\n"})
				held := request(s, "go")
				reload(s, "on go\n ask api to touch\n return 2\nend go\n", talk.ResetVariables)
				pump(bridgeNow)
				settled(held)
				o.Values = append(o.Values, released...)
				value(s.Grants())
			case "reload stale function":
				s := load(talk.LoadOptions{Name: "s", Source: "on make\n return given x: x + 1\nend make\n"})
				made := request(s, "make")
				pump(bridgeNow)
				fn, _ := made.Result()
				_, before, err := g.Call(context.Background(), fn, []talk.Value{talk.Int(1)}, nil)
				if err != nil {
					t.Fatal(err)
				}
				reload(s, "on make\n return given x: x + 2\nend make\n", talk.ResetVariables)
				_, after, err := g.Call(context.Background(), fn, []talk.Value{talk.Int(1)}, nil)
				if err != nil {
					t.Fatal(err)
				}
				pump(bridgeNow)
				settled(before)
				settled(after)
			case "reload library":
				lib, err := core.CompileLibrary(talk.LibrarySource{Name: "maths", Source: "function bump n\n return n + 1\nend bump\n"}, nil, nil)
				if err != nil {
					t.Fatal(err)
				}
				s := load(talk.LoadOptions{Name: "s", Source: "on go\n return 1\nend go\n"})
				reload(s, "use bump from maths\non go\n return bump(1)\nend go\n", talk.ResetVariables)
				if err := g.AddLibrary(lib); err != nil {
					t.Fatal(err)
				}
				reload(s, "use bump from maths\non go\n return bump(1)\nend go\n", talk.ResetVariables)
				code(s.Extend("on more\n return bump(10)\nend more\n"))
				p, q := request(s, "go"), request(s, "more")
				pump(bridgeNow)
				settled(p)
				settled(q)
			case "reload reentrant":
				var s *talk.Script
				op := talk.Operation{Name: "touch", Result: talk.NothingShape, Do: func(*talk.Call, []talk.Value) (talk.Value, error) {
					_, err := s.Reload("on go\n return 9\nend go\n", talk.ResetVariables)
					if !isReentrant(err) {
						t.Error("Reload inside a callback was not refused", err)
					}
					if err := s.Extend("on more\nend more\n"); !isReentrant(err) {
						t.Error("Extend inside a callback was not refused", err)
					}
					return talk.Nothing, nil
				}}
				def, err := core.DefineCapability("api", op)
				if err != nil {
					t.Fatal(err)
				}
				s = load(talk.LoadOptions{Name: "s", Grants: map[string]*talk.Grant{"api": def.GrantAll(nil)}, Source: "on go\n ask api to touch\n return 1\nend go\n"})
				p := request(s, "go")
				pump(bridgeNow)
				settled(p)
			case "extend", "extend refusals":
				s := load(talk.LoadOptions{Name: "s", Source: counter})
				if name == "extend" {
					code(s.Extend("script variable k = 7\non more\n add 1 to n\n return [n, k]\nend more\n"))
					code(s.Extend("function helper\n return 3\nend helper\non third\n return helper()\nend third\n"))
				} else {
					code(s.Extend("on go\n return 0\nend go\n"))
					code(s.Extend("script variable n = 1\n"))
					code(s.Extend("on broken\n return (\nend broken\n"))
					code(s.Extend("on more\n wait 1 s\nend more\non call\n more\nend call\n"))
				}
				ps := []*talk.Pending{request(s, "go")}
				if name == "extend" {
					ps = append(ps, request(s, "more"), request(s, "third"))
				}
				pump(bridgeNow)
				for _, p := range ps {
					settled(p)
				}
			case "extend keeps waiting run":
				s := load(talk.LoadOptions{Name: "s", Source: counter})
				held := request(s, "hold")
				pump(bridgeNow)
				code(s.Extend("on more\n return n + 100\nend more\n"))
				more := request(s, "more")
				pump(bridgeNow.Add(time.Second))
				settled(held)
				settled(more)
			}
			o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(g.Inspect())))
			o.Trace = append([]string{}, trace.lines...)
			out = append(out, o)
		})
	}
	return out
}
