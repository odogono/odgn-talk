package corpus

import (
	"context"
	"fmt"
	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"time"
)

type traceLines []string

func (l *traceLines) Record(line string) { *l = append(*l, line) }

type executionBackend struct{}

func ExecutionBackends() map[string]Backend {
	return map[string]Backend{"trace": executionBackend{}, "disassembly": disassemblyBackend{}}
}
func (executionBackend) Support(c Case) string {
	for _, feature := range []string{"factories", "objects"} {
		if xs, ok := c.Setup[feature].([]any); ok && len(xs) > 0 {
			return feature + " execution belongs to later Go steps"
		}
	}
	if ops, ok := c.Setup["operations"].([]any); ok {
		for _, raw := range ops {
			op := raw.(Setup)
			if op["scope"] != nil || op["segmentBound"] == true {
				return "Scoped and Segment-bound Operations are not available"
			}
		}
	}
	b, e := os.ReadFile(filepath.Join(c.Dir, "case.trace"))
	if e != nil {
		return e.Error()
	}
	records, e := ParseTrace(string(b))
	if e != nil {
		return e.Error()
	}
	standards, _ := c.Setup["standard"].([]any)
	for _, r := range records {
		if r.Input && r.Name == "pump" {
			for _, raw := range standards {
				name := raw.(Setup)["capability"].(string)
				if name != "clock" && name != "timer" && name != "console" {
					return name + " Standard Capability factory remains deferred"
				}
			}
		}
		if r.Input && r.Name == "stub" && len(r.IDs) > 0 && r.IDs[0] == "clock.now" {
			for _, raw := range standards {
				if raw.(Setup)["capability"] == "clock" {
					return "Standard clock.now cannot use a Stub"
				}
			}
		}
		if r.Input && !strings.Contains("|add-library|load|reload|deliver|request|decide|pump|vars|counters|stub|revoke|cancel-run|answer|fail|", "|"+r.Name+"|") {
			return r.Name + " replay belongs to a later Go step"
		}
	}
	if scripts, ok := c.Setup["scripts"].([]any); ok {
		for _, raw := range scripts {
			setup := raw.(Setup)
			source, e := os.ReadFile(filepath.Join(c.Dir, setup["source"].(string)))
			if e != nil {
				return e.Error()
			}
			tree, e := syntax.Parse(string(source))
			if e != nil {
				continue
			}
			options := check.Options{PatternSize: setupLimits(setup["limits"]).PatternSize}
			checked := check.Check(tree, options)
			if len(checked.Diagnostics) > 0 {
				continue
			}
			unit, e := lower.Compile(checked, setup["name"].(string))
			if e != nil {
				return e.Error()
			}
			for _, body := range unit.Bodies {
				for _, i := range body.Code {
					if !machine.Supported(i) {
						return i.Name + " execution belongs to step3"
					}
				}
			}
		}
	}

	return ""
}
func (executionBackend) Run(c Case, records []Record) ([]string, error) {
	var lines traceLines
	core := talk.New()
	operations, e := setupOperations(core, c.Setup)
	if e != nil {
		return nil, e
	}
	libraries, e := setupLibraries(core, c, operations.declarations)
	if e != nil {
		return nil, e
	}
	g := core.NewGroup(talk.GroupOptions{Trace: &lines})
	setups := map[string]Setup{}
	for _, x := range c.Setup["scripts"].([]any) {
		s := x.(Setup)
		setups[s["name"].(string)] = s
	}
	for _, r := range records {
		if !r.Input {
			continue
		}
		fields := map[string]Field{}
		for _, f := range r.Fields {
			fields[f.Key] = f
		}
		switch r.Name {
		case "add-library":
			if e := g.AddLibrary(libraries[r.IDs[0]]); e != nil {
				if _, ok := e.(*talk.HostError); !ok {
					return nil, e
				}
			}
		case "answer", "fail":
			call := operations.calls[talk.CallID(r.IDs[0])]
			if call == nil {
				return nil, fmt.Errorf("unknown call %s", r.IDs[0])
			}
			if r.Name == "answer" {
				v, e := construct(fields["value"].Value)
				if e != nil {
					return nil, e
				}
				fuel, _ := strconv.ParseInt(fields["fuel"].Raw, 10, 64)
				call.AnswerWithCost(v, fuel)
			} else {
				v := fields["error"].Value
				if v.Get("code").Text == "" {
					call.Fail(nil)
				} else {
					var data []talk.Pair
					for _, p := range v.Entries {
						if p.Key != "code" && p.Key != "message" {
							value, e := construct(p.Val)
							if e != nil {
								return nil, e
							}
							data = append(data, talk.KV(p.Key, value))
						}
					}
					m, _ := talk.Map(data...)
					call.Fail(&talk.ScriptError{Code: v.Get("code").Text, Message: v.Get("message").Text, Data: m})
				}
			}
		case "stub":
			lines = append(lines, r.Raw)
			operations.stubs[r.IDs[0]] = append(operations.stubs[r.IDs[0]], fields)
		case "cancel-run":
			name, _, _ := strings.Cut(r.IDs[0], "/r")
			s := g.Script(name)
			if s == nil {
				return nil, fmt.Errorf("unknown Script %s", name)
			}
			s.CancelRun(talk.RunID(r.IDs[0]))
		case "revoke":
			s := g.Script(r.IDs[0])
			if s == nil {
				return nil, fmt.Errorf("unknown Script %s", r.IDs[0])
			}
			s.Revoke(fields["grant"].Raw)
		case "reload":
			s := g.Script(r.IDs[0])
			if s == nil {
				return nil, fmt.Errorf("unknown Script %s", r.IDs[0])
			}
			carry := talk.ResetVariables
			if fields["carry"].Raw == "yes" {
				carry = talk.CarryVariables
			}
			_, e := s.Reload(fields["source"].Value.Text, carry)
			if e != nil {
				if _, ok := e.(*talk.LoadError); !ok {
					if _, ok := e.(*talk.HostError); !ok {
						return nil, e
					}
				}
			}
		case "load":
			name := r.IDs[0]
			setup := setups[name]
			b, e := os.ReadFile(filepath.Join(c.Dir, setup["source"].(string)))
			if e != nil {
				return nil, e
			}
			grants, err := operations.grants(setup)
			if err != nil {
				return nil, err
			}
			asUsed, _ := setup["grantsAsUsed"].(bool)
			_, e = g.Load(talk.LoadOptions{Name: name, Source: string(b), Limits: setupLimits(setup["limits"]), Grants: grants, GrantsAsUsed: asUsed})
			if e != nil {
				if _, ok := e.(*talk.LoadError); !ok {
					return nil, e
				}
			}
		case "deliver", "request", "decide":
			s := g.Script(fields["to"].Raw)
			if s == nil {
				return nil, fmt.Errorf("unknown Script %s", fields["to"].Raw)
			}
			m := talk.Message{Name: fields["message"].Raw}
			if raw, ok := fields["limits"]; ok {
				o := setupOverride(raw)
				m.Limits = &o
			}
			for _, v := range fields["args"].Value.Items {
				x, e := construct(v)
				if e != nil {
					return nil, e
				}
				m.Args = append(m.Args, x)
			}
			var e error
			if r.Name == "request" {
				_, _, e = s.Request(context.Background(), m)
			} else if r.Name == "decide" {
				_, _, e = s.Decide(context.Background(), m)
			} else {
				_, e = s.Deliver(m)
			}
			if e != nil && e != talk.ErrMailboxFull {
				if _, ok := e.(*talk.HostError); !ok {
					return nil, e
				}
			}
		case "pump":
			clock := fields["clock"].Value
			now := time.Unix(clock.Seconds, int64(clock.Nanos))
			opts := talk.PumpOptions{}
			opts.FuelCap, _ = strconv.ParseInt(fields["fuel-cap"].Raw, 10, 64)
			opts.FuelSlice, _ = strconv.ParseInt(fields["fuel-slice"].Raw, 10, 64)
			if _, e := g.Pump(now, opts); e != nil {
				if _, ok := e.(*talk.HostError); !ok {
					return nil, e
				}
			}
		case "vars":
			g.Inspect()
		case "counters":
			s := g.Script(r.IDs[0])
			if s == nil {
				return nil, fmt.Errorf("unknown Script %s", r.IDs[0])
			}
			s.Counters()
		}
	}
	return lines, nil
}

func setupLimits(raw any) talk.Limits {
	l := talk.Limits{}
	m, ok := raw.(Setup)
	if !ok {
		return l
	}
	v := reflect.ValueOf(&l).Elem()
	for _, entry := range generated.Limits.Limit {
		if n, ok := m[entry.Ts].(int64); ok {
			if entry.Go == "MaxWait" {
				n *= int64(time.Millisecond)
			}
			v.FieldByName(entry.Go).SetInt(n)
		}
	}
	return l
}
func setupOverride(f Field) talk.LimitOverride {
	o := talk.LimitOverride{}
	for _, p := range f.Value.Entries {
		n, _ := p.Val.Number.Int64()
		switch p.Key {
		case "fuelPerRun":
			o.FuelPerRun = n
		case "allocPerRun":
			o.AllocPerRun = n
		case "maxWait":
			o.MaxWait = time.Duration(n) * time.Millisecond
		case "maxJoin":
			o.MaxJoin = int(n)
		}
	}
	return o
}
