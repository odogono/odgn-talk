package northtalk_test

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	talk "northtalk.org/go"
)

// Libraries use the shared native-Go comparison harness. Compilation is a
// Core call, so its identity, needs and diagnostics are observed directly.
func runLibraryBridgeCases(t *testing.T) []bridgeObservation {
	t.Helper()
	var out []bridgeObservation
	for _, name := range []string{"library use", "library imports", "library stdlib", "library compile errors", "library add refusals", "library replace", "library replace carry", "library replace refusal", "library replace waiting", "library needs", "library replace release"} {
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
			describe := func(l *talk.Library) {
				id := l.Identity()
				imports := []string{}
				for _, i := range l.Imports() {
					imports = append(imports, i.Name())
				}
				o.Values = append(o.Values, l.Name(), l.Version(), hex.EncodeToString(id[:]))
				value([]any{imports, l.Needs()})
			}
			compile := func(src talk.LibrarySource, imports []*talk.Library, decls talk.GrantDecls) *talk.Library {
				l, err := core.CompileLibrary(src, imports, decls)
				if err != nil {
					t.Fatal(err)
				}
				describe(l)
				return l
			}
			add := func(l *talk.Library) {
				if err := g.AddLibrary(l); err != nil {
					t.Fatal(err)
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
					value([]any{v, failure})
				default:
					o.Values = append(o.Values, "open")
				}
			}
			replace := func(l *talk.Library, carry talk.CarryOver) {
				reports, err := g.ReplaceLibrary(l, carry)
				code(err)
				value(reports)
			}
			maths := talk.LibrarySource{Name: "maths", Version: "1", Source: "constant offset = 2\nfunction bump n, times = 3\n return n * times + offset\nend bump\n"}
			user := "script variable n = 0\nuse bump from maths\non go x\n add 1 to n\n return [bump(x), bump(x, 1), n]\nend go\n"
			switch name {
			case "library use":
				add(compile(maths, nil, nil))
				s := load(talk.LoadOptions{Name: "s", Source: user})
				p := request(s, "go", talk.Int(4))
				pump(bridgeNow)
				settled(p)
			case "library imports":
				base := compile(maths, nil, nil)
				top := compile(talk.LibrarySource{Name: "twice", Version: "a", Source: "use bump from maths\nfunction twice n\n return bump(bump(n))\nend twice\n"}, []*talk.Library{base}, nil)
				add(base)
				add(top)
				s := load(talk.LoadOptions{Name: "s", Source: "use twice from twice\non go\n return twice(1)\nend go\n"})
				p := request(s, "go")
				pump(bridgeNow)
				settled(p)
			case "library stdlib":
				s := load(talk.LoadOptions{Name: "s", Source: "use toHex from bytes\nuse pad from text\non go\n try\n  return [toHex(<<0xCA, 0xFE>>), pad(\"x\", -1)]\n catch e\n  return [toHex(<<0xCA>>), the code of e]\n end try\nend go\n"})
				p := request(s, "go")
				pump(bridgeNow)
				settled(p)
				_, err := core.CompileLibrary(talk.LibrarySource{Name: "uses", Source: "use toHex from bytes\nfunction show b\n return toHex(b)\nend show\n"}, nil, nil)
				code(err)
			case "library compile errors":
				base := compile(maths, nil, nil)
				for _, src := range []talk.LibrarySource{
					{Name: "broken", Source: "function f\n return (\nend f\n"},
					{Name: "state", Source: "script variable x = 1\n"},
					{Name: "missing", Source: "use bump from maths\nfunction f\n return bump(1)\nend f\n"},
					{Name: "unknown", Source: "use nothing from maths\nfunction f\n return 1\nend f\n"},
					{Name: "send", Source: "function f\n send ping to me\nend f\n"},
					{Name: "join", Source: "on hold\n wait for all\n  ask io to pause and wait\n end wait\nend hold\n"},
					{Name: "undeclared", Source: "function read\n ask db to read\n return it\nend read\n"},
					{Name: "says", Source: "function shout\n say \"a\"\nend shout\n"},
				} {
					imports := []*talk.Library{}
					if src.Name == "unknown" {
						imports = []*talk.Library{base}
					}
					_, err := core.CompileLibrary(src, imports, nil)
					code(err)
				}
				// A Script whose `use` names a Library the Group lacks.
				_, err := g.Load(talk.LoadOptions{Name: "s", Source: user})
				code(err)
			case "library add refusals":
				v1 := compile(maths, nil, nil)
				v2 := compile(talk.LibrarySource{Name: "maths", Version: "2", Source: "function bump n\n return n\nend bump\n"}, nil, nil)
				top := compile(talk.LibrarySource{Name: "twice", Source: "use bump from maths\nfunction twice n\n return bump(bump(n))\nend twice\n"}, []*talk.Library{v2}, nil)
				code(g.AddLibrary(v1))
				code(g.AddLibrary(v1))
				code(g.AddLibrary(v2))
				code(g.AddLibrary(top))
				code(g.AddLibrary(nil))
				fake := compile(talk.LibrarySource{Name: "text", Source: "function f\n return 1\nend f\n"}, nil, nil)
				code(g.AddLibrary(fake))
			case "library replace", "library replace carry":
				add(compile(maths, nil, nil))
				s := load(talk.LoadOptions{Name: "s", Source: user})
				pump(bridgeNow)
				p := request(s, "go", talk.Int(4))
				pump(bridgeNow)
				settled(p)
				carry := talk.ResetVariables
				if name == "library replace carry" {
					carry = talk.CarryVariables
				}
				replace(compile(talk.LibrarySource{Name: "maths", Version: "2", Source: "constant offset = 100\nfunction bump n, times = 3\n return n * times + offset\nend bump\n"}, nil, nil), carry)
				p = request(s, "go", talk.Int(4))
				pump(bridgeNow)
				settled(p)
			case "library replace refusal":
				add(compile(maths, nil, nil))
				s := load(talk.LoadOptions{Name: "s", Source: user})
				replace(compile(talk.LibrarySource{Name: "maths", Version: "2", Source: "function other n\n return n\nend other\n"}, nil, nil), talk.ResetVariables)
				code(g.AddLibrary(nil))
				p := request(s, "go", talk.Int(4))
				pump(bridgeNow)
				settled(p)
			case "library replace waiting":
				add(compile(talk.LibrarySource{Name: "helper", Source: "on pause n\n wait 1 s\n return n\nend pause\n"}, nil, nil))
				s := load(talk.LoadOptions{Name: "s", Source: "use pause from helper\non go\n pause 2 and wait\n return it\nend go\n"})
				p := request(s, "go")
				pump(bridgeNow)
				replace(compile(talk.LibrarySource{Name: "helper", Version: "2", Source: "on pause n\n wait 1 s\n return n * 10\nend pause\n"}, nil, nil), talk.ResetVariables)
				settled(p)
				p = request(s, "go")
				pump(bridgeNow.Add(time.Second))
				pump(bridgeNow.Add(2 * time.Second))
				settled(p)
			case "library needs", "library replace release":
				var released []string
				op := talk.Operation{Name: "touch", Args: []talk.Shape{talk.NumberShape}, Result: talk.NumberShape, Do: func(_ *talk.Call, args []talk.Value) (talk.Value, error) {
					return args[0], nil
				}}
				def, err := core.DefineCapability("api", op, talk.WithReleaseHook(func(c talk.GrantContext) {
					released = append(released, c.ScriptName+":"+c.GrantName+":"+string(c.Reason))
				}))
				if err != nil {
					t.Fatal(err)
				}
				decls := talk.GrantDecls{"api": {"touch": {Mode: talk.Immediate, Args: []talk.Shape{talk.NumberShape}}}}
				lib := compile(talk.LibrarySource{Name: "tool", Source: "function poke n\n ask api to touch n\n return it\nend poke\n"}, nil, decls)
				_, err = core.CompileLibrary(talk.LibrarySource{Name: "bad", Source: "function poke n\n ask api to touch \"x\"\n return it\nend poke\n"}, nil, decls)
				code(err)
				add(lib)
				_, err = g.Load(talk.LoadOptions{Name: "ungranted", Source: "use poke from tool\non go\n return poke(1)\nend go\n"})
				code(err)
				s := load(talk.LoadOptions{Name: "s", GrantsAsUsed: true, Grants: map[string]*talk.Grant{"api": def.GrantAll(nil)}, Source: "use poke from tool\non go\n return poke(5)\nend go\n"})
				p := request(s, "go")
				pump(bridgeNow)
				settled(p)
				value(s.Grants())
				if name == "library replace release" {
					replace(compile(talk.LibrarySource{Name: "tool", Version: "2", Source: "function poke n\n ask api to touch n + 1\n return it\nend poke\n"}, nil, decls), talk.ResetVariables)
					p = request(s, "go")
					pump(bridgeNow)
					settled(p)
				}
				o.Values = append(o.Values, released...)
			}
			o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(g.Inspect())))
			o.Trace = append([]string{}, trace.lines...)
			out = append(out, o)
		})
	}
	return out
}
