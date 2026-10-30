package northtalk_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	talk "northtalk.org/go"
)

// Host Objects use the shared native-Go comparison harness. Property
// callbacks receive the public handle, so identity checks run in both Cores.
func runObjectBridgeCases(t *testing.T) []bridgeObservation {
	t.Helper()
	var out []bridgeObservation
	for _, name := range []string{"object path", "object climb", "object unowned", "object decide", "object values", "object properties", "object property failures", "object property callback", "object owner disposal", "object parent refusals", "object foreign refusals", "object capability shapes", "object climb full", "object receiving limits", "object owner refusals", "object stopped receiver", "object kind in callback"} {
		t.Run(name, func(t *testing.T) {
			o := bridgeObservation{Name: name}
			var trace bridgeTrace
			core := talk.New()
			g := core.NewGroup(talk.GroupOptions{Name: "g", Trace: &trace})
			other := core.NewGroup(talk.GroupOptions{Name: "other"})
			room, err := core.DefineObjectKind(talk.ObjectKindDef{Name: "room", ParentKinds: []string{"room"}})
			if err != nil {
				t.Fatal(err)
			}
			object := func(id string) *talk.Object {
				h, err := g.Object(room, id, nil)
				if err != nil {
					t.Fatal(err)
				}
				return h
			}
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
			value := func(v any) {
				data, err := json.Marshal(bridgeCanonical(reflect.ValueOf(v)))
				if err != nil {
					t.Fatal(err)
				}
				o.Values = append(o.Values, string(data))
			}
			code := func(err error) {
				var host *talk.HostError
				if err == nil {
					o.Values = append(o.Values, "ok")
				} else if errors.Is(err, talk.ErrMailboxFull) {
					o.Values = append(o.Values, "mailbox full")
				} else if errors.As(err, &host) {
					o.Values = append(o.Values, string(host.Code))
				} else {
					t.Fatalf("expected a HostError, got %v", err)
				}
			}
			settled := func(p *talk.Pending) {
				select {
				case <-p.Done():
					v, failure := p.Result()
					value([]any{v, failure})
				default:
					o.Values = append(o.Values, "open")
				}
			}
			switch name {
			case "object path", "object climb":
				parent, leaf := object("parent"), object("leaf")
				load(talk.LoadOptions{Name: "parent", Owner: parent, Source: "on ping x\n return [the id of me, the id of the target, x]\nend ping"})
				if name == "object climb" {
					load(talk.LoadOptions{Name: "leaf", Owner: leaf, Source: "on ping x\n pass ping\nend ping"})
				}
				if err := g.SetParent(leaf, parent); err != nil {
					t.Fatal(err)
				}
				_, p, err := g.Request(context.Background(), leaf, talk.Message{Name: "ping", Args: []talk.Value{leaf.Value()}})
				if err != nil {
					t.Fatal(err)
				}
				id, err := g.Deliver(leaf, talk.Message{Name: "ping", Args: []talk.Value{talk.Int(2)}})
				if err != nil {
					t.Fatal(err)
				}
				o.Values = append(o.Values, string(id))
				pump()
				settled(p)
			case "object unowned":
				leaf := object("leaf")
				_, p, err := g.Request(context.Background(), leaf, talk.Message{Name: "ping"})
				if err != nil {
					t.Fatal(err)
				}
				pump()
				settled(p)
			case "object decide":
				parent, leaf := object("parent"), object("leaf")
				load(talk.LoadOptions{Name: "leaf", Owner: leaf, Source: "on other\nend other"})
				load(talk.LoadOptions{Name: "parent", Owner: parent, Source: "on enter, deciding\n veto the target\nend enter"})
				if err := g.SetParent(leaf, parent); err != nil {
					t.Fatal(err)
				}
				_, d, err := g.Decide(context.Background(), leaf, talk.Message{Name: "enter"})
				if err != nil {
					t.Fatal(err)
				}
				_, unowned, err := g.Decide(context.Background(), object("loose"), talk.Message{Name: "enter"})
				if err != nil {
					t.Fatal(err)
				}
				pump()
				value([]any{d.Decided(), unowned.Decided()})
			case "object values":
				a, b := object("a"), object("b")
				s := load(talk.LoadOptions{Name: "keeper", Objects: map[string]*talk.Object{"home": a}, Source: "script variable kept = nothing\non keep x\n put x into kept\n return [home, x, the id of item 2 of x]\nend keep"})
				list := talk.List(a.Value(), b.Value())
				_, p, err := s.Request(context.Background(), talk.Message{Name: "keep", Args: []talk.Value{list}})
				if err != nil {
					t.Fatal(err)
				}
				pump()
				settled(p)
				// Handles decoded from results are the Host's own.
				if v, _ := p.Result(); v.Kind() == talk.KindList {
					got, ok := v.Index(1).AsObject()
					if !ok || got != a {
						t.Fatal("result did not resolve to the registered handle")
					}
				}
				if again, ok := g.ObjectByID("room", "b"); !ok || again != b {
					t.Fatal("ObjectByID did not find the registered handle")
				}
			case "object properties":
				var label atomic.Value
				label.Store(talk.Value(talk.Nothing))
				text, _ := talk.Text("off")
				label.Store(text)
				light, err := core.DefineObjectKind(talk.ObjectKindDef{Name: "light", Props: []talk.Prop{
					{Name: "label", Shape: talk.TextShape, GetCost: talk.Cost{Fuel: 2}, SetCost: talk.Cost{Fuel: 5, Alloc: 3},
						Get: func(*talk.Object) (talk.Value, error) { return label.Load().(talk.Value), nil },
						Set: func(_ *talk.Object, v talk.Value) error { label.Store(v); return nil }},
					{Name: "watts", Shape: talk.NumberShape, Get: func(*talk.Object) (talk.Value, error) { return talk.Int(60), nil }},
				}})
				if err != nil {
					t.Fatal(err)
				}
				bulb, err := g.Object(light, "bulb", nil)
				if err != nil {
					t.Fatal(err)
				}
				s := load(talk.LoadOptions{Name: "s", Objects: map[string]*talk.Object{"bulb": bulb}, Source: "on go k\n put [the label of bulb, the \"watts\" of bulb, the absent of bulb] into before\n set the (k) of bulb to \"on\"\n return [before, the (k) of bulb, the id of bulb]\nend go\non later k\n try\n  return the (k) of bulb\n catch e\n  return [the code of e, the object of e]\n end try\nend later\non write k, v\n try\n  set the (k) of bulb to v\n catch e\n  return the code of e\n end try\nend write"})
				key, _ := talk.Text("label")
				watts, _ := talk.Text("watts")
				if _, err := s.Deliver(talk.Message{Name: "go", Args: []talk.Value{key}}); err != nil {
					t.Fatal(err)
				}
				if _, err := s.Deliver(talk.Message{Name: "write", Args: []talk.Value{watts, talk.Int(1)}}); err != nil {
					t.Fatal(err)
				}
				if _, err := s.Deliver(talk.Message{Name: "write", Args: []talk.Value{key, talk.Int(1)}}); err != nil {
					t.Fatal(err)
				}
				pump()
				if err := g.Dispose(bulb); err != nil {
					t.Fatal(err)
				}
				if _, err := s.Deliver(talk.Message{Name: "later", Args: []talk.Value{key}}); err != nil {
					t.Fatal(err)
				}
				pump()
				value(label.Load())
			case "object property failures":
				calls := 0
				gauge, err := core.DefineObjectKind(talk.ObjectKindDef{Name: "gauge", Props: []talk.Prop{
					{Name: "wrong", Shape: talk.NumberShape, Get: func(*talk.Object) (talk.Value, error) { calls++; return talk.Bool(true), nil }},
					{Name: "failing", Shape: talk.NumberShape, Get: func(*talk.Object) (talk.Value, error) {
						calls++
						return talk.Nothing, &talk.ScriptError{Code: "sensor offline", Message: "offline", Data: talk.Int(3)}
					}},
					{Name: "broken", Shape: talk.NumberShape, Get: func(*talk.Object) (talk.Value, error) { calls++; return talk.Nothing, errors.New("disk") }},
					{Name: "panics", Shape: talk.NumberShape, Get: func(*talk.Object) (talk.Value, error) { calls++; panic("boom") }},
					{Name: "dear", Shape: talk.NumberShape, GetCost: talk.Cost{Fuel: 1000}, Get: func(*talk.Object) (talk.Value, error) { calls++; return talk.Int(1), nil }},
				}})
				if err != nil {
					t.Fatal(err)
				}
				meter, err := g.Object(gauge, "m", nil)
				if err != nil {
					t.Fatal(err)
				}
				s := load(talk.LoadOptions{Name: "s", Objects: map[string]*talk.Object{"meter": meter}, Source: "on read k\n try\n  return the (k) of meter\n catch e\n  return e\n end try\nend read"})
				for _, prop := range []string{"wrong", "failing", "broken", "panics"} {
					k, _ := talk.Text(prop)
					if _, err := s.Deliver(talk.Message{Name: "read", Args: []talk.Value{k}}); err != nil {
						t.Fatal(err)
					}
				}
				dear, _ := talk.Text("dear")
				if _, err := s.Deliver(talk.Message{Name: "read", Args: []talk.Value{dear}, Limits: &talk.LimitOverride{FuelPerRun: 50}}); err != nil {
					t.Fatal(err)
				}
				pump()
				value(calls)
			case "object property callback":
				var g2 *talk.Group = g
				var target *talk.Object
				var first atomic.Bool
				probe, err := core.DefineObjectKind(talk.ObjectKindDef{Name: "probe", Props: []talk.Prop{
					{Name: "poke", Shape: talk.NothingShape, Get: func(self *talk.Object) (talk.Value, error) {
						if self.ID() != "p" {
							t.Error("property received the wrong handle")
						}
						if first.Swap(true) {
							return talk.Nothing, nil
						}
						if _, err := g2.Deliver(target, talk.Message{Name: "ping"}); err != nil {
							t.Error(err)
						}
						if _, err := g2.Object(room, "late", nil); err != nil {
							t.Error(err)
						}
						if err := g2.Dispose(self); err != nil {
							t.Error(err)
						}
						if _, err := g2.Pump(bridgeNow, talk.PumpOptions{}); !isReentrant(err) {
							t.Error(err)
						}
						return talk.Nothing, nil
					}},
				}})
				if err != nil {
					t.Fatal(err)
				}
				p, err := g.Object(probe, "p", nil)
				if err != nil {
					t.Fatal(err)
				}
				target = object("target")
				load(talk.LoadOptions{Name: "target", Owner: target, Source: "on ping\n return 1\nend ping"})
				s := load(talk.LoadOptions{Name: "s", Objects: map[string]*talk.Object{"p": p}, Source: "on go\n get the poke of p\n return the poke of p\nend go"})
				if _, err := s.Deliver(talk.Message{Name: "go"}); err != nil {
					t.Fatal(err)
				}
				pump()
				pump()
			case "object owner disposal":
				a, b := object("a"), object("b")
				load(talk.LoadOptions{Name: "child", Owner: a, Source: "on hold\n wait 1 s\nend hold\non ping\n return \"child\"\nend ping"})
				load(talk.LoadOptions{Name: "parent", Owner: b, Source: "on ping\n return [the id of me, the id of the target]\nend ping"})
				if err := g.SetParent(a, b); err != nil {
					t.Fatal(err)
				}
				if _, err := g.Deliver(a, talk.Message{Name: "hold"}); err != nil {
					t.Fatal(err)
				}
				pump()
				if err := g.Dispose(a); err != nil {
					t.Fatal(err)
				}
				_, p, err := g.Request(context.Background(), a, talk.Message{Name: "ping"})
				if err != nil {
					t.Fatal(err)
				}
				pump()
				settled(p)
				if err := g.Dispose(a); err != nil {
					t.Fatal(err)
				}
				pump()
			case "object parent refusals":
				a, b, c := object("a"), object("b"), object("c")
				if err := g.SetParent(a, b); err != nil {
					t.Fatal(err)
				}
				code(g.SetParent(b, a))
				code(g.SetParent(a, a))
				if err := g.SetParent(b, c); err != nil {
					t.Fatal(err)
				}
				// Known only at drain: the child is disposed before the change lands.
				if err := g.Dispose(c); err != nil {
					t.Fatal(err)
				}
				if err := g.SetParent(c, a); err != nil {
					t.Fatal(err)
				}
				pump()
				code(g.SetParent(c, nil))
				if err := g.SetParent(a, nil); err != nil {
					t.Fatal(err)
				}
				pump()
				_, err := g.Object(room, "a", nil)
				code(err)
			case "object foreign refusals":
				mine := object("mine")
				foreign, err := other.Object(room, "mine", nil)
				if err != nil {
					t.Fatal(err)
				}
				s := load(talk.LoadOptions{Name: "s", Owner: mine, Source: "on ping x\n return x\nend ping"})
				_, err = s.Deliver(talk.Message{Name: "ping", Args: []talk.Value{foreign.Value()}})
				code(err)
				_, err = g.Deliver(foreign, talk.Message{Name: "ping", Args: []talk.Value{talk.Int(1)}})
				code(err)
				_, _, err = g.Request(context.Background(), foreign, talk.Message{Name: "ping", Args: []talk.Value{talk.Int(1)}})
				code(err)
				_, _, err = g.Decide(context.Background(), foreign, talk.Message{Name: "ping", Args: []talk.Value{talk.Int(1)}})
				code(err)
				code(g.SetParent(mine, foreign))
				code(g.SetParent(foreign, mine))
				code(g.Dispose(foreign))
				_, err = g.Load(talk.LoadOptions{Name: "t", Owner: foreign, Source: "on ping\nend ping"})
				code(err)
				_, err = g.Load(talk.LoadOptions{Name: "u", Objects: map[string]*talk.Object{"x": foreign}, Source: "on ping\nend ping"})
				code(err)
				if _, err := g.Deliver(mine, talk.Message{Name: "ping", Args: []talk.Value{mine.Value()}}); err != nil {
					t.Fatal(err)
				}
				pump()
			case "object climb full":
				a, b := object("a"), object("b")
				child := load(talk.LoadOptions{Name: "child", Owner: a, Source: "on ping\n pass ping\nend ping"})
				parent := load(talk.LoadOptions{Name: "parent", Owner: b, Limits: talk.Limits{MailboxDepth: 1}, Source: "on ping\n return 1\nend ping"})
				if err := g.SetParent(a, b); err != nil {
					t.Fatal(err)
				}
				_, p, err := child.Request(context.Background(), talk.Message{Name: "ping"})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := parent.Deliver(talk.Message{Name: "ping"}); err != nil {
					t.Fatal(err)
				}
				pump()
				settled(p)
			case "object receiving limits":
				a, b, leaf := object("a"), object("b"), object("leaf")
				load(talk.LoadOptions{Name: "old", Owner: a, Limits: talk.Limits{FuelPerRun: 1000}, Source: "on ping\n pass ping\nend ping"})
				load(talk.LoadOptions{Name: "next", Owner: b, Limits: talk.Limits{FuelPerRun: 10}, Source: "on ping\n repeat 20 times\n end repeat\nend ping"})
				if err := g.SetParent(leaf, a); err != nil {
					t.Fatal(err)
				}
				if err := g.SetParent(a, b); err != nil {
					t.Fatal(err)
				}
				pump()
				_, p, err := g.Request(context.Background(), leaf, talk.Message{Name: "ping", Limits: &talk.LimitOverride{FuelPerRun: 500}})
				if err != nil {
					t.Fatal(err)
				}
				pump()
				settled(p)
			case "object owner refusals":
				a, gone := object("a"), object("gone")
				foreign, err := other.Object(room, "f", nil)
				if err != nil {
					t.Fatal(err)
				}
				if err := g.Dispose(gone); err != nil {
					t.Fatal(err)
				}
				pump()
				load(talk.LoadOptions{Name: "first", Owner: a, Source: "on go\n return me\nend go"})
				for _, options := range []talk.LoadOptions{
					{Name: "again", Owner: a, Source: "on go\nend go"},
					{Name: "disposed", Owner: gone, Source: "on go\nend go"},
					{Name: "both", Owner: a, Objects: map[string]*talk.Object{"x": foreign}, Source: "on go\nend go"},
					{Name: "foreign", Owner: foreign, Objects: map[string]*talk.Object{"x": a}, Source: "on go\nend go"},
				} {
					_, err := g.Load(options)
					code(err)
				}
			case "object stopped receiver":
				owner := object("owner")
				load(talk.LoadOptions{Name: "receiver", Owner: owner, Source: "on ping\n return 42\nend ping"})
				sender := load(talk.LoadOptions{Name: "sender", Source: "on go\n send ping to receiver\n send ping to receiver and wait\nend go"})
				if err := g.Dispose(owner); err != nil {
					t.Fatal(err)
				}
				_, p, err := sender.Request(context.Background(), talk.Message{Name: "go"})
				if err != nil {
					t.Fatal(err)
				}
				pump()
				settled(p)
			case "object kind in callback":
				late, err := core.DefineObjectKind(talk.ObjectKindDef{Name: "late"})
				if err != nil {
					t.Fatal(err)
				}
				op := talk.Operation{Name: "make", Result: talk.ObjectShape(late), Do: func(c *talk.Call, _ []talk.Value) (talk.Value, error) {
					h, err := c.Group().Object(late, "k", nil)
					if err != nil {
						return talk.Nothing, err
					}
					if err := c.Group().Dispose(h); err != nil {
						return talk.Nothing, err
					}
					return h.Value(), nil
				}}
				def, err := core.DefineCapability("host", op)
				if err != nil {
					t.Fatal(err)
				}
				s := load(talk.LoadOptions{Name: "s", Grants: map[string]*talk.Grant{"host": def.GrantAll(nil)}, Source: "script variable held = nothing\non go\n ask host to make\n put it into held\n return isDisposed(held)\nend go\non later\n return isDisposed(held)\nend later"})
				for _, m := range []string{"go", "later"} {
					if _, err := s.Deliver(talk.Message{Name: m}); err != nil {
						t.Fatal(err)
					}
					pump()
				}
			case "object capability shapes":
				var seen []string
				op := talk.Operation{Name: "visit", Args: []talk.Shape{talk.ObjectShape(room)}, Result: talk.ObjectShape(room), Do: func(_ *talk.Call, args []talk.Value) (talk.Value, error) {
					h, ok := args[0].AsObject()
					if !ok {
						t.Error("Object argument did not decode to a handle")
						return talk.Nothing, nil
					}
					seen = append(seen, h.ID())
					next, _ := g.ObjectByID("room", "b")
					return next.Value(), nil
				}}
				def, err := core.DefineCapability("api", op)
				if err != nil {
					t.Fatal(err)
				}
				a, _ := object("a"), object("b")
				s := load(talk.LoadOptions{Name: "s", Objects: map[string]*talk.Object{"start": a}, Grants: map[string]*talk.Grant{"api": def.GrantAll(nil)}, Source: "on go\n ask api to visit start\n return the id of it\nend go"})
				_, p, err := s.Request(context.Background(), talk.Message{Name: "go"})
				if err != nil {
					t.Fatal(err)
				}
				pump()
				settled(p)
				o.Values = append(o.Values, strings.Join(seen, ","))
			}
			o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(g.Inspect())))
			o.Trace = append([]string{}, trace.lines...)
			out = append(out, o)
		})
	}
	return out
}
