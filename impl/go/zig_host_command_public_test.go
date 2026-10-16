package northtalk_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// Host Commands (ADR 0094) use the shared native-Go comparison harness: an
// Operation declared `command` is called by its name alone, through the
// Message Layer's declarations, and lowered as its `tell` or `ask`.
func runHostCommandBridgeCases(t *testing.T) []bridgeObservation {
	t.Helper()
	var out []bridgeObservation
	for _, name := range []string{"host command calls", "host command shadowing", "host command load checks", "host command library", "host command grants as used", "host command reserved word"} {
		t.Run(name, func(t *testing.T) {
			o := bridgeObservation{Name: name}
			var trace bridgeTrace
			core := talk.New()
			g := core.NewGroup(talk.GroupOptions{Name: "g", Trace: &trace})
			pump := func() {
				r, err := g.Pump(bridgeNow, talk.PumpOptions{})
				if err != nil {
					t.Fatal(err)
				}
				o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(r)))
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
			load := func(options talk.LoadOptions) *talk.Script {
				s, err := g.Load(options)
				if err != nil {
					t.Fatal(err)
				}
				return s
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
					value([]any{v, failure})
				default:
					o.Values = append(o.Values, "open")
				}
			}
			tea, _ := talk.Text("tea")
			var fetching *talk.Call
			till, err := core.DefineCapability("till",
				talk.Operation{Name: "price", Args: []talk.Shape{talk.TextShape}, Result: talk.NumberShape, Cost: talk.Cost{Fuel: 10}, Command: true, Do: func(c *talk.Call, args []talk.Value) (talk.Value, error) {
					o.Calls = append(o.Calls, string(c.ID())+" price "+args[0].String())
					return talk.Int(2), nil
				}},
				talk.Operation{Name: "note", Mode: talk.FireAndForget, Args: []talk.Shape{talk.TextShape}, Cost: talk.Cost{Fuel: 5}, Command: true, Fire: func(c *talk.Call, args []talk.Value) error {
					o.Calls = append(o.Calls, string(c.ID())+" note "+args[0].String())
					return nil
				}},
				talk.Operation{Name: "fetch", Mode: talk.Suspending, Args: []talk.Shape{talk.TextShape}, Result: talk.NumberShape, Cost: talk.Cost{Fuel: 20}, Command: true, Start: func(c *talk.Call, args []talk.Value) error {
					o.Calls = append(o.Calls, string(c.ID())+" fetch "+args[0].String())
					fetching = c
					return nil
				}},
				talk.Operation{Name: "plain", Result: talk.NumberShape, Do: func(*talk.Call, []talk.Value) (talk.Value, error) {
					return talk.Int(9), nil
				}},
			)
			if err != nil {
				t.Fatal(err)
			}
			all := func() map[string]*talk.Grant { return map[string]*talk.Grant{"till": till.GrantAll(nil)} }
			switch name {
			case "host command calls":
				s := load(talk.LoadOptions{Name: "s", Grants: all(), Source: "script variable total = 0\non ring sku\n price sku\n note \"rang \" & sku & \" at \" & it\n fetch sku and wait\n add it to total\n return total\nend ring\n"})
				p := request(s, "ring", tea)
				pump()
				settled(p)
				fetching.Answer(talk.Int(3))
				pump()
				settled(p)
			case "host command shadowing":
				s := load(talk.LoadOptions{Name: "s", Grants: all(), Source: "on go\n price \"e4\"\n put it into seen\n note \"moved\"\n plain\n note \"moved\" to \"rook\"\n return [seen, it]\nend go\non price sku\n return 1\nend price\non plain\n return 0\nend plain\n"})
				p := request(s, "go")
				pump()
				settled(p)
			case "host command load checks":
				for _, source := range []string{
					"on go\n price \"a\" and wait\n fetch \"a\"\n note \"a\" and wait\n note\n note 1\n fetch \"a\" and wait\nend go\n",
					"on go\n wait for all\n  fetch \"a\" and wait\n end wait\nend go\n",
				} {
					_, err := g.Load(talk.LoadOptions{Name: "refused", Grants: all(), Source: source})
					code(err)
				}
				spare, err := till.Grant([]string{"price"}, nil)
				if err != nil {
					t.Fatal(err)
				}
				_, err = g.Load(talk.LoadOptions{Name: "twice", Grants: map[string]*talk.Grant{"till": till.GrantAll(nil), "spare": spare}, Source: "on go\n note \"a\"\n price \"a\"\nend go\n"})
				code(err)
				prices, err := core.CompileLibrary(talk.LibrarySource{Name: "prices", Version: "1", Source: "on price sku\n return 1\nend price\n"}, nil, nil)
				if err != nil {
					t.Fatal(err)
				}
				code(g.AddLibrary(prices))
				_, err = g.Load(talk.LoadOptions{Name: "importer", Grants: all(), Source: "use price from prices\n"})
				code(err)
				_, err = g.Load(talk.LoadOptions{Name: "ungranted", Source: "use price from prices\n"})
				code(err)
			case "host command library":
				decls := talk.GrantDecls{"till": {
					"price": {Mode: talk.Immediate, Args: []talk.Shape{talk.TextShape}, Command: true},
					"note":  {Mode: talk.FireAndForget, Args: []talk.Shape{talk.TextShape}, Command: true},
				}}
				lib, err := core.CompileLibrary(talk.LibrarySource{Name: "register", Version: "1", Source: "on ring sku\n price sku\n note \"rang \" & sku & \" at \" & it\n return it\nend ring\n"}, nil, decls)
				if err != nil {
					t.Fatal(err)
				}
				value(lib.Needs())
				code(g.AddLibrary(lib))
				_, err = g.Load(talk.LoadOptions{Name: "bare", Source: "use ring from register\non go sku\n ring sku\n return it\nend go\n"})
				code(err)
				s := load(talk.LoadOptions{Name: "s", Grants: all(), Source: "use ring from register\non go sku\n ring sku\n return it\nend go\n"})
				p := request(s, "go", tea)
				pump()
				settled(p)
			case "host command grants as used":
				s := load(talk.LoadOptions{Name: "s", Grants: all(), GrantsAsUsed: true, Source: "on go\n price \"tea\"\n return it\nend go\n"})
				value(s.Grants())
				p := request(s, "go")
				pump()
				settled(p)
				code(s.Extend("on extra\n note \"x\"\nend extra\n"))
			case "host command reserved word":
				_, err := core.DefineCapability("bad", talk.Operation{Name: "if", Result: talk.NumberShape, Command: true, Do: func(*talk.Call, []talk.Value) (talk.Value, error) {
					return talk.Int(1), nil
				}})
				code(err)
			}
			o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(g.Inspect())))
			o.Trace = append([]string{}, trace.lines...)
			out = append(out, o)
		})
	}
	return out
}
