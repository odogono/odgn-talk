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
	for _, feature := range []string{"libraries", "operations", "factories", "objects"} {
		if xs, ok := c.Setup[feature].([]any); ok && len(xs) > 0 {
			return feature + " execution belongs to later Go steps"
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
	for _, r := range records {
		if r.Input && !strings.Contains("|load|deliver|request|decide|pump|vars|counters|", "|"+r.Name+"|") {
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
			if grants, ok := setup["grants"].(Setup); ok && len(grants) > 0 {
				return "Capability grants belong to step3"
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
	g := talk.New().NewGroup(talk.GroupOptions{Trace: &lines})
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
		case "load":
			name := r.IDs[0]
			setup := setups[name]
			b, e := os.ReadFile(filepath.Join(c.Dir, setup["source"].(string)))
			if e != nil {
				return nil, e
			}
			_, e = g.Load(talk.LoadOptions{Name: name, Source: string(b), Limits: setupLimits(setup["limits"])})
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
