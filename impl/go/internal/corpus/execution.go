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

type replayDelivery struct {
	cancel    context.CancelFunc
	done      <-chan struct{}
	cancelled bool
}

func (d *replayDelivery) cancelAndWait(ready <-chan struct{}) error {
	if d.cancelled {
		return nil
	}
	d.cancelled = true
	select {
	case <-d.done:
		d.cancel()
		return nil
	default:
	}
	// Discard earlier notifications, then wait for context.AfterFunc to queue
	// cancellation through the public API before replaying the next Host input.
	select {
	case <-ready:
	default:
	}
	d.cancel()
	select {
	case <-ready:
		return nil
	case <-time.After(5 * time.Second):
		return fmt.Errorf("Delivery cancellation did not notify onReady")
	}
}

// Controls recorded inside a Pump are issued at their recorded Host crossing.
type crossingReplay struct {
	lines    *traceLines
	controls map[string][][]Record
	apply    func(Record) error
	err      error
}

func (r *crossingReplay) Record(line string) {
	r.lines.Record(line)
	parts := strings.SplitN(line, " ", 3)
	if len(parts) < 2 || parts[0] != "call" && parts[0] != "prop" {
		return
	}
	key := parts[0] + " " + parts[1]
	queue := r.controls[key]
	if len(queue) == 0 {
		return
	}
	controls := queue[0]
	r.controls[key] = queue[1:]
	for _, control := range controls {
		if err := r.apply(control); err != nil {
			r.err = err
		}
	}
}

type executionBackend struct{}

func ExecutionBackends() map[string]Backend {
	return map[string]Backend{"trace": executionBackend{}, "disassembly": disassemblyBackend{}}
}
func (executionBackend) Support(c Case) string {
	for _, feature := range []string{"factories"} {
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
	standards, _ := c.Setup["standard"].([]any)
	cancellable := map[string]bool{}
	for _, r := range records {
		if r.Input && len(r.IDs) > 0 {
			switch r.Name {
			case "request", "decide", "decide-broadcast", "call-value":
				cancellable[r.IDs[0]] = true
			case "cancel-delivery":
				if !cancellable[r.IDs[0]] {
					return "Delivery cancellation requires a Request, Decision or Host call context"
				}
			}
		}
		if r.Input && r.Name == "pump" {
			for _, raw := range standards {
				name := raw.(Setup)["capability"].(string)
				if name != "clock" && name != "timer" && name != "console" && name != "calendar" && name != "locale" {
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
		if r.Input && !strings.Contains("|add-library|load|reload|deliver|request|decide|broadcast|decide-broadcast|pump|vars|counters|stub|stub-effect|revoke|stop|cancel-run|cancel-delivery|answer|fail|dispose|set-parent|call-value|", "|"+r.Name+"|") {
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
			bindings, _ := setup["objects"].(Setup)
			for name := range bindings {
				options.Objects = append(options.Objects, name)
			}
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
	crossings := &crossingReplay{lines: &lines, controls: map[string][][]Record{}}
	inside := map[int]bool{}
	inPump, crossing := false, ""
	for i, r := range records {
		if r.Input && r.Name == "pump" {
			inPump = true
			crossing = ""
		}
		if !r.Input && r.Name == "pumped" {
			inPump = false
		}
		if inPump && !r.Input && (r.Name == "call" || r.Name == "prop") && len(r.IDs) > 0 {
			crossing = r.Name + " " + r.IDs[0]
			crossings.controls[crossing] = append(crossings.controls[crossing], nil)
		}
		if inPump && r.Input && (r.Name == "stop" || r.Name == "cancel-run") {
			if crossing == "" {
				return nil, fmt.Errorf("%s inside Pump has no Host crossing", r.Name)
			}
			queue := crossings.controls[crossing]
			queue[len(queue)-1] = append(queue[len(queue)-1], r)
			inside[i] = true
		}
	}
	core := talk.New()
	operations, e := setupOperations(core, c.Setup)
	if e != nil {
		return nil, e
	}
	libraries, e := setupLibraries(core, c, operations.declarations)
	if e != nil {
		return nil, e
	}
	ready := make(chan struct{}, 1)
	g := core.NewGroup(talk.GroupOptions{Trace: crossings, OnReady: func() {
		select {
		case ready <- struct{}{}:
		default:
		}
	}})
	deliveries := map[string]*replayDelivery{}
	control := func(r Record) error {
		name := r.IDs[0]
		if r.Name == "cancel-run" {
			name, _, _ = strings.Cut(name, "/r")
		}
		s := g.Script(name)
		if s == nil {
			return fmt.Errorf("unknown Script %s", name)
		}
		if r.Name == "cancel-run" {
			s.CancelRun(talk.RunID(r.IDs[0]))
		} else {
			for _, f := range r.Fields {
				if f.Key == "reason" {
					s.Stop(f.Value.Text)
					return nil
				}
			}
			return fmt.Errorf("Stop has no reason")
		}
		return nil
	}
	crossings.apply = control
	objects, e := setupObjects(core, g, c.Setup, operations.values)
	if e != nil {
		return nil, e
	}
	values := operations.values
	setups := map[string]Setup{}
	for _, x := range c.Setup["scripts"].([]any) {
		s := x.(Setup)
		setups[s["name"].(string)] = s
	}
	for _, i := range replayInputOrder(records) {
		r := records[i]
		if !r.Input || inside[i] {
			continue
		}
		fields := map[string]Field{}
		for _, f := range r.Fields {
			fields[f.Key] = f
		}
		switch r.Name {
		case "cancel-delivery":
			d := deliveries[r.IDs[0]]
			if d == nil {
				return nil, fmt.Errorf("unknown cancellable Delivery %s", r.IDs[0])
			}
			if err := d.cancelAndWait(ready); err != nil {
				return nil, err
			}
		case "set-parent":
			ref := fields["object"].Value.Object
			if ref == nil {
				return nil, fmt.Errorf("set-parent requires Object")
			}
			var parent *talk.Object
			if p := fields["parent"].Value.Object; p != nil {
				parent = objects[objectRef{p.Kind, p.ID}]
			}
			if err := g.SetParent(objects[objectRef{ref.Kind, ref.ID}], parent); err != nil {
				if _, ok := err.(*talk.HostError); !ok {
					return nil, err
				}
			}
		case "call-value":
			ref := fields["fn"].Value.Function
			if ref == nil {
				return nil, fmt.Errorf("call-value requires Function")
			}
			fn, err := values.construct(fields["fn"].Value)
			if err != nil {
				return nil, err
			}
			var args []talk.Value
			for _, v := range fields["args"].Value.Items {
				x, err := values.construct(v)
				if err != nil {
					return nil, err
				}
				args = append(args, x)
			}
			var limits *talk.LimitOverride
			if f, ok := fields["limits"]; ok {
				o := setupOverride(f)
				limits = &o
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			id, pending, err := g.Call(ctx, fn, args, limits)
			if err == nil {
				deliveries[string(id)] = &replayDelivery{cancel: cancel, done: pending.Done()}
			} else {
				if _, ok := err.(*talk.HostError); !ok && err != talk.ErrMailboxFull {
					return nil, err
				}
			}
		case "dispose":
			ref := fields["object"].Value.Object
			if ref == nil {
				return nil, fmt.Errorf("dispose requires Object")
			}
			if err := g.Dispose(objects[objectRef{ref.Kind, ref.ID}]); err != nil {
				return nil, err
			}
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
				v, e := values.construct(fields["value"].Value)
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
							value, e := values.construct(p.Val)
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
		case "stub-effect":
			lines = append(lines, r.Raw)
			key := r.IDs[0] + "." + fields["phase"].Raw
			operations.effectStubs[key] = append(operations.effectStubs[key], fields)
		case "stop", "cancel-run":
			if err := control(r); err != nil {
				return nil, err
			}
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
			bindings, err := objects.bindings(setup)
			if err != nil {
				return nil, err
			}
			var owner *talk.Object
			if ref, ok := setup["owner"].(Setup); ok {
				owner = objects[objectRef{ref["kind"].(string), ref["id"].(string)}]
				if owner == nil {
					return nil, fmt.Errorf("unknown owner %v", ref)
				}
			}
			_, e = g.Load(talk.LoadOptions{Owner: owner, Name: name, Source: string(b), Limits: setupLimits(setup["limits"]), Grants: grants, GrantsAsUsed: asUsed, Objects: bindings})
			if e != nil {
				if _, ok := e.(*talk.LoadError); !ok {
					return nil, e
				}
			}
		case "deliver", "request", "decide", "broadcast", "decide-broadcast":
			s := g.Script(fields["to"].Raw)
			var target *talk.Object
			if ref := fields["to"].Value.Object; ref != nil {
				target = objects[objectRef{ref.Kind, ref.ID}]
			}
			if s == nil && target == nil && r.Name != "broadcast" && r.Name != "decide-broadcast" {
				return nil, fmt.Errorf("unknown recipient %s", fields["to"].Raw)
			}
			m := talk.Message{Name: fields["message"].Raw}
			if raw, ok := fields["limits"]; ok {
				o := setupOverride(raw)
				m.Limits = &o
			}
			for _, v := range fields["args"].Value.Items {
				x, e := values.construct(v)
				if e != nil {
					return nil, e
				}
				m.Args = append(m.Args, x)
			}
			var e error
			var id talk.DeliveryID
			var pending *talk.Pending
			var decision *talk.Deciding
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if r.Name == "broadcast" {
				_, e = g.Broadcast(m)
			} else if r.Name == "decide-broadcast" {
				var bid talk.BroadcastID
				bid, decision, e = g.DecideBroadcast(ctx, m)
				id = talk.DeliveryID(bid)
			} else if target != nil {
				if r.Name == "request" {
					id, pending, e = g.Request(ctx, target, m)
				} else if r.Name == "decide" {
					id, decision, e = g.Decide(ctx, target, m)
				} else {
					_, e = g.Deliver(target, m)
				}
			} else if r.Name == "request" {
				id, pending, e = s.Request(ctx, m)
			} else if r.Name == "decide" {
				id, decision, e = s.Decide(ctx, m)
			} else {
				_, e = s.Deliver(m)
			}
			if pending != nil {
				deliveries[string(id)] = &replayDelivery{cancel: cancel, done: pending.Done()}
			} else if decision != nil {
				deliveries[string(id)] = &replayDelivery{cancel: cancel, done: decision.Done()}
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
			result, e := g.Pump(now, opts)
			if crossings.err != nil {
				return nil, crossings.err
			}
			for _, report := range result.Reports {
				switch report := report.(type) {
				case *talk.RunEnd:
					values.receive(report.Result)
					if report.Error != nil {
						values.receive(report.Error.Data)
					}
				case *talk.Unhandled:
					for _, arg := range report.Message.Args {
						values.receive(arg)
					}
				}
			}
			if e != nil {
				if _, ok := e.(*talk.HostError); !ok {
					return nil, e
				}
			}
		case "vars":
			for _, script := range g.Inspect().Scripts {
				for _, entry := range script.Vars {
					values.receive(entry.Val)
				}
				for _, message := range script.Mailbox {
					for _, arg := range message.Message.Args {
						values.receive(arg)
					}
				}
			}
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

// Refused admissions are traced immediately; accepted inputs are traced only
// when the Pump drains them. Queue the accepted inputs before retrying mailbox
// refusals, while keeping their order and emitting the original Trace order.
func replayInputOrder(records []Record) []int {
	var order, refused []int
	for i, r := range records {
		if r.Input && i+1 < len(records) && records[i+1].Raw == `refused code="mailbox full"` {
			refused = append(refused, i)
			continue
		}
		if r.Input && r.Name == "pump" {
			order = append(order, refused...)
			refused = nil
		}
		order = append(order, i)
	}
	return append(order, refused...)
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
