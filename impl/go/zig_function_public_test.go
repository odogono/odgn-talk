package northtalk_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// Function Values use the shared native-Go comparison harness. A Host holds
// them opaquely, so observations record their Home Script, display and
// equality rather than their encoding.
func runFunctionBridgeCases(t *testing.T) []bridgeObservation {
	t.Helper()
	var out []bridgeObservation
	for _, name := range []string{"function call", "function captures", "function defaults and arity", "function as argument", "function nested values", "function stale home", "function cancel", "function overrides", "function refusals", "function capability", "function callback call", "function inspection", "function foreign full", "function foreign stopped"} {
		t.Run(name, func(t *testing.T) {
			o := bridgeObservation{Name: name}
			var trace bridgeTrace
			core := talk.New()
			readied := make(chan struct{}, 64)
			g := core.NewGroup(talk.GroupOptions{Name: "g", Trace: &trace, OnReady: func() {
				select {
				case readied <- struct{}{}:
				default:
				}
			}})
			other := core.NewGroup(talk.GroupOptions{Name: "other"})
			pump := func() {
				r, err := g.Pump(bridgeNow, talk.PumpOptions{})
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
			code := func(err error) {
				var host *talk.HostError
				var script *talk.ScriptError
				switch {
				case err == nil:
					o.Values = append(o.Values, "ok")
				case errors.As(err, &host):
					o.Values = append(o.Values, string(host.Code))
				case errors.As(err, &script):
					o.Values = append(o.Values, script.Code)
				default:
					t.Fatalf("unexpected error %v", err)
				}
			}
			value := func(v any) {
				data, err := json.Marshal(bridgeCanonical(reflect.ValueOf(v)))
				if err != nil {
					t.Fatal(err)
				}
				o.Values = append(o.Values, string(data))
			}
			describe := func(fn talk.Value) {
				home, ok := fn.HomeScript()
				o.Values = append(o.Values, fmt.Sprint(fn.Kind() == talk.KindFunction), home, fn.String(), map[bool]string{false: "not function", true: "function"}[ok])
			}
			settled := func(p *talk.Pending) {
				select {
				case <-p.Done():
					v, failure := p.Result()
					if v.Kind() == talk.KindFunction {
						describe(v)
						v = talk.Nothing
					}
					value([]any{v, failure})
				default:
					o.Values = append(o.Values, "open")
				}
			}
			// export Requests a Function Value from its Home Script.
			export := func(s *talk.Script, m string, args ...talk.Value) talk.Value {
				_, p, err := s.Request(context.Background(), talk.Message{Name: m, Args: args})
				if err != nil {
					t.Fatal(err)
				}
				pump()
				v, failure := p.Result()
				if failure != nil || v.Kind() != talk.KindFunction {
					t.Fatalf("export: %v %v", v, failure)
				}
				describe(v)
				return v
			}
			call := func(fn talk.Value, args ...talk.Value) *talk.Pending {
				_, p, err := g.Call(context.Background(), fn, args, nil)
				if err != nil {
					t.Fatal(err)
				}
				return p
			}
			switch name {
			case "function call", "function captures", "function defaults and arity":
				source := map[string]string{
					"function call":               "function double n\n return n * 2\nend double\non exported k\n return double\nend exported",
					"function captures":           "script variable total = 0\non exported k\n put 3 into offset\n return given n\n  add n + offset + k to total\n  return total\n end given\nend exported",
					"function defaults and arity": "function sum a, b = 5\n return a + b\nend sum\non exported k\n return sum\nend exported",
				}[name]
				home := load(talk.LoadOptions{Name: "home", Source: source})
				fn := export(home, "exported", talk.Int(10))
				again := export(home, "exported", talk.Int(10))
				o.Values = append(o.Values, map[bool]string{false: "unequal", true: "equal"}[fn.Equal(again)])
				ps := []*talk.Pending{call(fn, talk.Int(4))}
				if name == "function defaults and arity" {
					ps = append(ps, call(fn, talk.Int(1), talk.Int(2)), call(fn), call(fn, talk.Int(1), talk.Int(2), talk.Int(3)))
				} else {
					ps = append(ps, call(fn, talk.Int(5)))
				}
				pump()
				for _, p := range ps {
					settled(p)
				}
			case "function as argument":
				home := load(talk.LoadOptions{Name: "home", Source: "on exported\n return given n\n  wait 1s\n  return n + 1\n end given\nend exported"})
				caller := load(talk.LoadOptions{Name: "caller", Source: "on go callback\n callback(7) and wait\n return [it, callback]\nend go"})
				fn := export(home, "exported")
				_, p, err := caller.Request(context.Background(), talk.Message{Name: "go", Args: []talk.Value{fn}})
				if err != nil {
					t.Fatal(err)
				}
				pump()
				r, err := g.Pump(bridgeNow.Add(time.Second), talk.PumpOptions{})
				if err != nil {
					t.Fatal(err)
				}
				o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(r)))
				select {
				case <-p.Done():
					v, failure := p.Result()
					if failure != nil {
						t.Fatal(failure)
					}
					value(v.Index(1))
					describe(v.Index(2))
					o.Values = append(o.Values, map[bool]string{false: "unequal", true: "equal"}[v.Index(2).Equal(fn)])
				default:
					t.Fatal("Request did not settle")
				}
			case "function nested values":
				home := load(talk.LoadOptions{Name: "home", Source: "on exported\n return [given: 1, {f: given x: x}]\nend exported"})
				_, p, err := home.Request(context.Background(), talk.Message{Name: "exported"})
				if err != nil {
					t.Fatal(err)
				}
				pump()
				v, failure := p.Result()
				if failure != nil {
					t.Fatal(failure)
				}
				describe(v.Index(1))
				describe(v.Index(2).Get("f"))
				o.Values = append(o.Values, v.String())
				// Data encodings still refuse it; the Message Layer is the only carrier.
				_, err = talk.EncodeValue(v)
				code(err)
				echo := load(talk.LoadOptions{Name: "echo", Source: "on echo x\n return x\nend echo"})
				_, p, err = echo.Request(context.Background(), talk.Message{Name: "echo", Args: []talk.Value{v}})
				if err != nil {
					t.Fatal(err)
				}
				pump()
				back, _ := p.Result()
				o.Values = append(o.Values, back.String(), map[bool]string{false: "unequal", true: "equal"}[back.Equal(v)])
			case "function stale home":
				home := load(talk.LoadOptions{Name: "home", Source: "on exported\n return given: 5\nend exported"})
				fn := export(home, "exported")
				p := call(fn)
				home.Stop("gone")
				pump()
				settled(p)
				again := call(fn)
				pump()
				settled(again)
			case "function cancel":
				home := load(talk.LoadOptions{Name: "home", Source: "on exported\n return given\n  wait 1s\n  return 1\n end given\nend exported"})
				fn := export(home, "exported")
				for _, started := range []bool{false, true} {
					ctx, cancel := context.WithCancel(context.Background())
					_, p, err := g.Call(ctx, fn, nil, nil)
					if err != nil {
						t.Fatal(err)
					}
					if started {
						pump()
					}
					for len(readied) > 0 {
						<-readied
					}
					// The cancellation queues from its own goroutine.
					cancel()
					select {
					case <-readied:
					case <-time.After(5 * time.Second):
						t.Fatal("cancellation was not queued")
					}
					pump()
					settled(p)
				}
			case "function overrides":
				home := load(talk.LoadOptions{Name: "home", Limits: talk.Limits{FuelPerRun: 60}, Source: "on exported\n return given\n  repeat 10 times\n  end repeat\n end given\nend exported"})
				fn := export(home, "exported")
				var ps []*talk.Pending
				for _, limits := range []*talk.LimitOverride{{FuelPerRun: 20}, {FuelPerRun: 60}} {
					_, p, err := g.Call(context.Background(), fn, nil, limits)
					if err != nil {
						t.Fatal(err)
					}
					ps = append(ps, p)
				}
				for _, limits := range []*talk.LimitOverride{{FuelPerRun: 61}, {FuelPerRun: -1}, {MaxWait: time.Microsecond}, {Set: 1 << 7}} {
					_, p, err := g.Call(context.Background(), fn, nil, limits)
					if p != nil {
						t.Fatal("refused Call returned a future")
					}
					code(err)
				}
				pump()
				for _, p := range ps {
					settled(p)
				}
			case "function refusals":
				home := load(talk.LoadOptions{Name: "home", Source: "on exported\n return given x: x\nend exported\non echo x\n return x\nend echo"})
				fn := export(home, "exported")
				foreignHome, err := other.Load(talk.LoadOptions{Name: "home", Source: "on exported\n return given: 1\nend exported"})
				if err != nil {
					t.Fatal(err)
				}
				_, fp, err := foreignHome.Request(context.Background(), talk.Message{Name: "exported"})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := other.Pump(bridgeNow, talk.PumpOptions{}); err != nil {
					t.Fatal(err)
				}
				foreign, _ := fp.Result()
				_, _, err = g.Call(context.Background(), foreign, nil, nil)
				code(err)
				_, _, err = g.Call(context.Background(), talk.Int(1), nil, nil)
				code(err)
				_, _, err = g.Call(context.Background(), fn, []talk.Value{foreign}, nil)
				code(err)
				_, err = home.Deliver(talk.Message{Name: "echo", Args: []talk.Value{talk.List(foreign)}})
				code(err)
				_, _, err = other.Call(context.Background(), fn, nil, nil)
				code(err)
				_, err = g.Broadcast(talk.Message{Name: "echo", Args: []talk.Value{foreign}})
				code(err)
				pump()
			case "function capability":
				var got []string
				var keep talk.Value
				op := talk.Operation{Name: "keep", Args: []talk.Shape{talk.FunctionShape}, Result: talk.FunctionShape, Do: func(_ *talk.Call, args []talk.Value) (talk.Value, error) {
					home, _ := args[0].HomeScript()
					got = append(got, home, args[0].String())
					keep = args[0]
					return args[0], nil
				}}
				show := talk.Operation{Name: "show", Args: []talk.Shape{talk.AnyShape}, Result: talk.NothingShape, Do: func(*talk.Call, []talk.Value) (talk.Value, error) { return talk.Nothing, nil }}
				def, err := core.DefineCapability("api", op, show)
				if err != nil {
					t.Fatal(err)
				}
				s := load(talk.LoadOptions{Name: "s", Grants: map[string]*talk.Grant{"api": def.GrantAll(nil)}, Source: "on go\n ask api to keep (given n: n + 1)\n put it into back\n try\n  ask api to show [back]\n catch e\n  return [back(1), the code of e]\n end try\nend go"})
				_, p, err := s.Request(context.Background(), talk.Message{Name: "go"})
				if err != nil {
					t.Fatal(err)
				}
				pump()
				settled(p)
				o.Values = append(o.Values, got...)
				kept := call(keep, talk.Int(41))
				pump()
				settled(kept)
			case "function callback call":
				var fn talk.Value
				var p *talk.Pending
				op := talk.Operation{Name: "touch", Result: talk.NothingShape, Do: func(c *talk.Call, _ []talk.Value) (talk.Value, error) {
					var err error
					_, p, err = c.Group().Call(context.Background(), fn, []talk.Value{talk.Int(2)}, nil)
					return talk.Nothing, err
				}}
				def, err := core.DefineCapability("api", op)
				if err != nil {
					t.Fatal(err)
				}
				home := load(talk.LoadOptions{Name: "home", Source: "on exported\n return given n: n * 3\nend exported"})
				fn = export(home, "exported")
				s := load(talk.LoadOptions{Name: "s", Grants: map[string]*talk.Grant{"api": def.GrantAll(nil)}, Source: "on go\n ask api to touch\nend go"})
				if _, err := s.Deliver(talk.Message{Name: "go"}); err != nil {
					t.Fatal(err)
				}
				pump()
				settled(p)
				pump()
				settled(p)
			case "function foreign full", "function foreign stopped":
				caller := load(talk.LoadOptions{Name: "caller", Source: "on go callback\n try\n  callback() and wait\n catch e\n  return e\n end try\nend go"})
				home := load(talk.LoadOptions{Name: "home", Limits: talk.Limits{MailboxDepth: 1}, Source: "on exported\n return given: 5\nend exported\non ping\nend ping"})
				fn := export(home, "exported")
				if name == "function foreign full" {
					if _, err := home.Deliver(talk.Message{Name: "ping"}); err != nil {
						t.Fatal(err)
					}
				} else {
					home.Stop("closed")
				}
				_, p, err := caller.Request(context.Background(), talk.Message{Name: "go", Args: []talk.Value{fn}})
				if err != nil {
					t.Fatal(err)
				}
				pump()
				settled(p)
			case "function inspection":
				home := load(talk.LoadOptions{Name: "home", Source: "script variable kept = nothing\non exported\n put given n: n into kept\n return kept\nend exported\non hold\n wait 1s\nend hold"})
				fn := export(home, "exported")
				if _, err := home.Deliver(talk.Message{Name: "hold"}); err != nil {
					t.Fatal(err)
				}
				pump()
				call(fn, talk.Int(1))
				vars := g.Inspect().Scripts[0].Vars
				for _, v := range vars {
					if v.Val.Kind() == talk.KindFunction {
						describe(v.Val)
						o.Values = append(o.Values, map[bool]string{false: "unequal", true: "equal"}[v.Val.Equal(fn)])
					}
				}
			}
			// Inspect holds Function Values; compare their display forms.
			inspection := g.Inspect()
			for i := range inspection.Scripts {
				for j, v := range inspection.Scripts[i].Vars {
					if v.Val.Kind() == talk.KindFunction {
						text, _ := talk.Text(v.Val.String())
						inspection.Scripts[i].Vars[j].Val = text
					}
				}
			}
			o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(inspection)))
			o.Trace = append([]string{}, trace.lines...)
			out = append(out, o)
		})
	}
	return out
}
