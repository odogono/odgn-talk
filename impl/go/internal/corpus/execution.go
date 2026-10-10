package corpus

import (
	"context"
	"fmt"
	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	"github.com/odogono/odgn-talk/impl/go/internal/replay"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"github.com/odogono/odgn-talk/impl/go/session"
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
	lines       *traceLines
	inputs      map[string][][]int
	applyInput  func(int) error
	err         error
	hidden      bool
	hiddenLines []string
	roundTrip   bool
	adopted     map[string]bool
	saveIDs     map[string]string
	visibleSave int
}

// Replay controls and refusals while the corresponding Host function is active.
func (r *crossingReplay) crossing(key string) {
	queue := r.inputs[key]
	if len(queue) == 0 {
		return
	}
	r.inputs[key] = queue[1:]
	for _, index := range queue[0] {
		if err := r.applyInput(index); err != nil {
			r.err = err
		}
	}
}

func crossingKey(r Record) string {
	if r.Name == "call" {
		return r.IDs[0]
	}
	fields := map[string]string{}
	for _, f := range r.Fields {
		fields[f.Key] = f.Raw
	}
	return fields["object"] + ":" + fields["name"] + ":" + fields["op"]
}

func (r *crossingReplay) Record(line string) {
	if r.hidden {
		r.hiddenLines = append(r.hiddenLines, line)
		return
	}
	if r.roundTrip {
		if strings.HasPrefix(line, "> settle ") {
			record, e := parseRecord(line)
			if e == nil && r.adopted[record.IDs[0]] {
				delete(r.adopted, record.IDs[0])
				return
			}
		}
		if strings.HasPrefix(line, "> save ") {
			actual := strings.TrimPrefix(line, "> save ")
			r.visibleSave++
			visible := fmt.Sprintf("s%d", r.visibleSave)
			r.saveIDs[actual] = visible
			line = "> save " + visible
		}
		if strings.HasPrefix(line, "> restore ") {
			record, e := parseRecord(line)
			if e == nil {
				for _, f := range record.Fields {
					if f.Key == "from" && r.saveIDs[f.Raw] != "" {
						line = strings.Replace(line, "from="+f.Raw, "from="+r.saveIDs[f.Raw], 1)
					}
				}
			}
		}
	}
	r.lines.Record(line)
}

type executionBackend struct{}

func ExecutionBackends() map[string]Backend {
	return map[string]Backend{"trace": executionBackend{}, "disassembly": disassemblyBackend{}, "transcript": sessionBackend{}}
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
				if name != "clock" && name != "timer" && name != "console" && name != "calendar" && name != "locale" && name != "store" && name != "sqlite" && name != "user" {
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
		if r.Input && !strings.Contains("|add-library|load|reload|extend|save|restore|settle|replace-library|deliver|request|decide|broadcast|decide-broadcast|pump|vars|counters|stub|stub-effect|revoke|stop|cancel-run|rewind-run|cancel-delivery|answer|fail|dispose|set-parent|call-value|", "|"+r.Name+"|") {
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
	return runReplayPair(c, records, nil)
}

func runReplayPair(c Case, records []Record, prepare func(*operationReplay)) ([]string, error) {
	ordinary, err := runExecutionWithHost(c, records, false, prepare)
	if err != nil {
		return nil, err
	}
	restored, err := runExecutionWithHost(c, records, true, prepare)
	if err != nil {
		return nil, fmt.Errorf("save/restore replay: %w", err)
	}
	if err := Compare(c.Name+" (save/restore)", ordinary, restored); err != nil {
		return nil, err
	}
	return ordinary, nil
}
func runExecution(c Case, records []Record, roundTrip bool) ([]string, error) {
	return runExecutionWithHost(c, records, roundTrip, nil)
}

func runExecutionWithHost(c Case, records []Record, roundTrip bool, prepare func(*operationReplay)) ([]string, error) {
	x, err := newExecutionReplay(c.Setup, records, roundTrip, func(row Setup) (string, error) {
		b, err := os.ReadFile(filepath.Join(c.Dir, row["source"].(string)))
		return string(b), err
	})
	if err != nil {
		return nil, err
	}
	defer x.close()
	if prepare != nil {
		prepare(x.operations)
	}
	for _, i := range replayInputOrder(records) {
		if records[i].Input && !x.inside[i] {
			if err := x.apply(i); err != nil {
				return nil, err
			}
		}
	}
	if x.sessionObjects != nil {
		x.sessionObjects.Finish()
	}
	return x.lines, nil
}

// executionReplay replays Host Inputs on one Group through the public
// embedding API. Its records may grow as a driver appends inputs.
type executionReplay struct {
	sessionObjects  *session.Objects
	sessionBindings map[string]*talk.Object
	records         []Record
	roundTrip       bool
	readSource      func(Setup) (string, error)
	inside          map[int]bool
	lines           traceLines
	crossings       *crossingReplay
	core            *talk.Core
	operations      *operationReplay
	libraries       map[string]*talk.Library
	ready           chan struct{}
	g               *talk.Group
	deliveries      map[string]*replayDelivery
	objects         objectReplay
	saves           map[string][]byte
	saveIDs         []string
	values          *replayValues
	setups          map[string]Setup
	cancels         []context.CancelFunc
}

func newExecutionReplay(setup Setup, records []Record, roundTrip bool, readSource func(Setup) (string, error)) (*executionReplay, error) {
	x := &executionReplay{records: records, roundTrip: roundTrip, readSource: readSource, inside: map[int]bool{}, deliveries: map[string]*replayDelivery{}, saves: map[string][]byte{}}
	crossings := &crossingReplay{lines: &x.lines, inputs: map[string][][]int{}, roundTrip: roundTrip, adopted: map[string]bool{}, saveIDs: map[string]string{}}
	inPump, crossing := false, ""
	for i, r := range records {
		if r.Input && r.Name == "pump" && !(i+1 < len(records) && records[i+1].Name == "refused") {
			inPump = true
			crossing = ""
		}
		if !r.Input && r.Name == "pumped" {
			inPump = false
		}
		if inPump && !r.Input && (r.Name == "call" || r.Name == "prop") && len(r.IDs) > 0 {
			crossing = crossingKey(r)
			crossings.inputs[crossing] = append(crossings.inputs[crossing], nil)
		}
		if items, ok := setup["sessionObjects"].([]session.Item); ok && len(items) > 0 {
			continue
		}
		if inPump && r.Input && i+1 < len(records) && records[i+1].Name == "refused" {
			if crossing == "" {
				return nil, fmt.Errorf("refusal inside Pump has no Host crossing")
			}
			queue := crossings.inputs[crossing]
			queue[len(queue)-1] = append(queue[len(queue)-1], i)
			x.inside[i] = true
			continue
		}
		if inPump && r.Input && (r.Name == "stop" || r.Name == "cancel-run" || r.Name == "rewind-run") {
			if crossing == "" {
				return nil, fmt.Errorf("%s inside Pump has no Host crossing", r.Name)
			}
			queue := crossings.inputs[crossing]
			queue[len(queue)-1] = append(queue[len(queue)-1], i)
			x.inside[i] = true
		}
	}
	core := talk.New()
	operations, e := setupOperations(core, setup)
	if e != nil {
		return nil, e
	}
	declarations := talk.GrantDecls{}
	for name, ops := range operations.declarations {
		declarations[name] = ops
	}
	for _, raw := range setup["scripts"].([]any) {
		script := raw.(Setup)
		grants, _ := script["grants"].(Setup)
		for name, rawGrant := range grants {
			grant := rawGrant.(Setup)
			if capability, ok := grant["capability"].(string); ok && declarations[name] == nil {
				declarations[name] = operations.declarations[capability]
			}
		}
	}
	libraries, e := setupLibraries(core, setup, declarations, readSource)
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
	crossings.applyInput = x.apply
	operations.crossing = crossings.crossing
	var objects objectReplay
	if items, ok := setup["sessionObjects"].([]session.Item); ok && len(items) > 0 {
		x.sessionObjects = session.NewObjectReplay(core, g, items)
		x.sessionBindings = x.sessionObjects.Preload()
		objects = objectReplay{}
		for r, obj := range x.sessionObjects.Handles() {
			objects[objectRef{r[0], r[1]}] = obj
		}
		operations.values.objects = objects
	} else {
		objects, e = setupObjects(core, g, setup, operations.values, crossings.crossing)
	}
	if e != nil {
		return nil, e
	}
	values := operations.values
	setups := map[string]Setup{}
	for _, raw := range setup["scripts"].([]any) {
		s := raw.(Setup)
		setups[s["name"].(string)] = s
	}
	x.crossings, x.core, x.operations, x.libraries, x.ready, x.g, x.objects, x.values, x.setups = crossings, core, operations, libraries, ready, g, objects, values, setups
	return x, nil
}

func (x *executionReplay) close() {
	for _, cancel := range x.cancels {
		cancel()
	}
}

func (x *executionReplay) control(r Record) error {
	name := r.IDs[0]
	if r.Name == "cancel-run" || r.Name == "rewind-run" {
		name, _, _ = strings.Cut(name, "/r")
	}
	s := x.g.Script(name)
	if s == nil {
		return fmt.Errorf("unknown Script %s", name)
	}
	if r.Name == "cancel-run" {
		s.CancelRun(talk.RunID(r.IDs[0]))
		return nil
	}
	if r.Name == "rewind-run" {
		s.RewindRun(talk.RunID(r.IDs[0]))
		return nil
	}
	for _, f := range r.Fields {
		if f.Key == "reason" {
			s.Stop(f.Value.Text)
			return nil
		}
	}
	return fmt.Errorf("Stop has no reason")
}

func (x *executionReplay) apply(i int) error {
	records, roundTrip, r := x.records, x.roundTrip, x.records[i]
	if x.sessionObjects != nil {
		if x.sessionObjects.TraceInput(r.Name, r.IDs) {
			return nil
		}
		for r, obj := range x.sessionObjects.Handles() {
			x.objects[objectRef{r[0], r[1]}] = obj
		}
	}
	core, operations, libraries, values := x.core, x.operations, x.libraries, x.values
	setups, deliveries, crossings, ready := x.setups, x.deliveries, x.crossings, x.ready
	fields := map[string]Field{}
	for _, f := range r.Fields {
		fields[f.Key] = f
	}
	switch r.Name {
	case "cancel-delivery":
		d := deliveries[r.IDs[0]]
		if d == nil {
			return fmt.Errorf("unknown cancellable Delivery %s", r.IDs[0])
		}
		if err := d.cancelAndWait(ready); err != nil {
			return err
		}
	case "set-parent":
		ref := fields["object"].Value.Object
		if ref == nil {
			return fmt.Errorf("set-parent requires Object")
		}
		var parent *talk.Object
		if p := fields["parent"].Value.Object; p != nil {
			parent = x.objects[objectRef{p.Kind, p.ID}]
		}
		if err := x.g.SetParent(x.objects[objectRef{ref.Kind, ref.ID}], parent); err != nil {
			if _, ok := err.(*talk.HostError); !ok {
				return err
			}
		}
	case "call-value":
		ref := fields["fn"].Value.Function
		if ref == nil {
			return fmt.Errorf("call-value requires Function")
		}
		fn, err := values.construct(fields["fn"].Value)
		if err != nil {
			return err
		}
		var args []talk.Value
		for _, v := range fields["args"].Value.Items {
			x, err := values.construct(v)
			if err != nil {
				return err
			}
			args = append(args, x)
		}
		var limits *talk.LimitOverride
		if f, ok := fields["limits"]; ok {
			o := setupOverride(f)
			limits = &o
		}
		ctx, cancel := context.WithCancel(context.Background())
		x.cancels = append(x.cancels, cancel)
		id, pending, err := x.g.Call(ctx, fn, args, limits)
		if err == nil {
			deliveries[string(id)] = &replayDelivery{cancel: cancel, done: pending.Done()}
		} else {
			if _, ok := err.(*talk.HostError); !ok && err != talk.ErrMailboxFull {
				return err
			}
		}
	case "dispose":
		ref := fields["object"].Value.Object
		if ref == nil {
			return fmt.Errorf("dispose requires Object")
		}
		if err := x.g.Dispose(x.objects[objectRef{ref.Kind, ref.ID}]); err != nil {
			return err
		}
	case "add-library":
		if e := x.g.AddLibrary(libraries[r.IDs[0]]); e != nil {
			if _, ok := e.(*talk.HostError); !ok {
				return e
			}
		}
	case "answer", "fail":
		call := operations.calls[talk.CallID(r.IDs[0])]
		if call == nil {
			return fmt.Errorf("unknown call %s", r.IDs[0])
		}
		if r.Name == "answer" {
			v, e := values.construct(fields["value"].Value)
			if e != nil {
				return e
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
							return e
						}
						data = append(data, talk.KV(p.Key, value))
					}
				}
				m, _ := talk.Map(data...)
				call.Fail(&talk.ScriptError{Code: v.Get("code").Text, Message: v.Get("message").Text, Data: m})
			}
		}
	case "stub":
		x.lines = append(x.lines, r.Raw)
		operations.stubs[r.IDs[0]] = append(operations.stubs[r.IDs[0]], fields)
	case "stub-effect":
		x.lines = append(x.lines, r.Raw)
		key := r.IDs[0] + "." + fields["phase"].Raw
		operations.effectStubs[key] = append(operations.effectStubs[key], fields)
	case "stop", "cancel-run", "rewind-run":
		if err := x.control(r); err != nil {
			return err
		}
	case "revoke":
		s := x.g.Script(r.IDs[0])
		if s == nil {
			return fmt.Errorf("unknown Script %s", r.IDs[0])
		}
		s.Revoke(fields["grant"].Raw)
	case "save":
		if x.sessionObjects != nil {
			x.sessionObjects.Saved(r.IDs[0])
		}
		saved, err := x.g.Save()
		if err != nil {
			if host, ok := err.(*talk.HostError); !ok || host.Code != talk.EffectsPending {
				return err
			}
		} else {
			// An appended input leaves the Save id to the Core's record.
			id := ""
			if len(r.IDs) > 0 {
				id = r.IDs[0]
			} else if last, err := parseRecord(x.lines[len(x.lines)-1]); err == nil && last.Name == "save" && len(last.IDs) > 0 {
				id = last.IDs[0]
			}
			if _, seen := x.saves[id]; !seen {
				x.saveIDs = append(x.saveIDs, id)
			}
			x.saves[id] = saved
		}
	case "restore":
		selected := []*talk.Library{}
		withheld := map[string]bool{}
		for _, name := range fieldIDs(fields["withheld"]) {
			withheld[name] = true
		}
		for name, l := range libraries {
			if !withheld[name] {
				selected = append(selected, l)
			}
		}
		unbound := map[string]bool{}
		for _, name := range fieldIDs(fields["unbound"]) {
			unbound[name] = true
		}
		unresolved := map[objectRef]bool{}
		for _, v := range fields["disposed"].Value.Items {
			if v.Object != nil {
				unresolved[objectRef{v.Object.Kind, v.Object.ID}] = true
			}
		}
		for _, v := range fields["unresolved"].Value.Items {
			if v.Object != nil {
				unresolved[objectRef{v.Object.Kind, v.Object.ID}] = true
			}
		}
		policy := talk.RejectMismatch
		if fields["mismatch"].Raw == "variables-only" {
			policy = talk.VariablesOnly
		}
		next, restoredResult, err := core.Restore(x.saves[fields["from"].Raw], talk.RestoreOptions{Trace: crossings, OnReady: gReady(ready), Libraries: selected, Mismatch: policy, Grants: func(script, name string) *talk.Grant {
			if unbound[script+"."+name] {
				return nil
			}
			grants, _ := operations.grants(setups[script])
			return grants[name]
		}, Resolve: func(kind, id string) (any, bool) {
			if x.sessionObjects != nil && !crossings.hidden {
				return x.sessionObjects.Resolve(kind, id)
			}
			key := objectRef{kind, id}
			if unresolved[key] {
				return nil, false
			}
			if obj := x.objects[key]; obj != nil {
				return obj.Native(), true
			}
			return nil, false
		}})
		if err != nil {
			if _, ok := err.(*talk.HostError); !ok {
				return err
			}
			return nil
		}
		x.g = next
		if x.sessionObjects != nil {
			x.sessionObjects.Restored(fields["from"].Raw)
			x.sessionObjects.Reports(restoredResult.Reports)
			x.sessionObjects.Attach(next)
		}
		for name := range withheld {
			delete(libraries, name)
		}
		if roundTrip {
			crossings.visibleSave, _ = strconv.Atoi(strings.TrimPrefix(fields["from"].Raw, "s"))
		}
		// Reconstruct stable Object handles after restore.
		x.objects = restoredObjects(x.g, x.objects)
		values.objects = x.objects

	case "settle":
		var settlement talk.Settlement
		switch fields["how"].Raw {
		case "answer":
			v, err := values.construct(fields["value"].Value)
			if err != nil {
				return err
			}
			settlement.Answer = &v
		case "fail":
			v := fields["error"].Value
			data := []talk.Pair{}
			for _, p := range v.Entries {
				if p.Key != "code" && p.Key != "message" {
					x, err := values.construct(p.Val)
					if err != nil {
						return err
					}
					data = append(data, talk.KV(p.Key, x))
				}
			}
			m, _ := talk.Map(data...)
			settlement.Fail = &talk.ScriptError{Code: v.Get("code").Text, Message: v.Get("message").Text, Data: m}
		case "adopt":
			settlement.Adopt = true
		case "reissue":
			settlement.Reissue = true
		}
		call, err := x.g.Settle(talk.CallID(r.IDs[0]), settlement)
		if err != nil {
			if _, ok := err.(*talk.HostError); !ok {
				return err
			}
		} else if call != nil {
			operations.calls[call.ID()] = call
		}
	case "replace-library":
		imports := []*talk.Library{}
		for name, l := range libraries {
			if name != r.IDs[0] {
				imports = append(imports, l)
			}
		}
		l, err := core.CompileLibrary(talk.LibrarySource{Name: r.IDs[0], Source: fields["source"].Value.Text}, imports, operations.declarations)
		if err != nil {
			return err
		}
		carry := talk.ResetVariables
		if fields["carry"].Raw == "yes" {
			carry = talk.CarryVariables
		}
		_, err = x.g.ReplaceLibrary(l, carry)
		if err != nil {
			if _, ok := err.(*talk.HostError); !ok {
				if _, ok := err.(*talk.LoadError); !ok {
					return err
				}
			}
		} else {
			for _, raw := range replay.Libraries(x.g) {
				lib := raw.(*talk.Library)
				libraries[lib.Name()] = lib
			}
		}
	case "extend":
		if e := x.g.Script(r.IDs[0]).Extend(fields["source"].Value.Text); e != nil {
			if _, ok := e.(*talk.HostError); !ok {
				if _, ok := e.(*talk.LoadError); !ok {
					return e
				}
			}
		}
	case "reload":
		s := x.g.Script(r.IDs[0])
		if s == nil {
			return fmt.Errorf("unknown Script %s", r.IDs[0])
		}
		carry := talk.ResetVariables
		if fields["carry"].Raw == "yes" {
			carry = talk.CarryVariables
		}
		_, e := s.Reload(fields["source"].Value.Text, carry, talk.ReloadOptions{KeepMailbox: fields["mailbox"].Raw == "keep"})
		if e != nil {
			if _, ok := e.(*talk.LoadError); !ok {
				if _, ok := e.(*talk.HostError); !ok {
					return e
				}
			}
		}
	case "load":
		name := r.IDs[0]
		setup := setups[name]
		source, e := x.readSource(setup)
		if e != nil {
			return e
		}
		grants, err := operations.grants(setup)
		if err != nil {
			return err
		}
		asUsed, _ := setup["grantsAsUsed"].(bool)
		bindings, err := x.objects.bindings(setup)
		if x.sessionObjects != nil {
			bindings = x.sessionBindings
			err = nil
		}
		if err != nil {
			return err
		}
		var owner *talk.Object
		if ref, ok := setup["owner"].(Setup); ok {
			owner = x.objects[objectRef{ref["kind"].(string), ref["id"].(string)}]
			if owner == nil {
				return fmt.Errorf("unknown owner %v", ref)
			}
		}
		_, e = x.g.Load(talk.LoadOptions{Owner: owner, Name: name, Source: source, Limits: setupLimits(setup["limits"]), Grants: grants, GrantsAsUsed: asUsed, Objects: bindings})
		if e != nil {
			if _, ok := e.(*talk.LoadError); !ok {
				return e
			}
		}
	case "deliver", "request", "decide", "broadcast", "decide-broadcast":
		s := x.g.Script(fields["to"].Raw)
		var target *talk.Object
		if ref := fields["to"].Value.Object; ref != nil {
			target = x.objects[objectRef{ref.Kind, ref.ID}]
		}
		if s == nil && target == nil && r.Name != "broadcast" && r.Name != "decide-broadcast" {
			return fmt.Errorf("unknown recipient %s", fields["to"].Raw)
		}
		m := talk.Message{Name: fields["message"].Raw}
		if raw, ok := fields["limits"]; ok {
			o := setupOverride(raw)
			m.Limits = &o
		}
		for _, v := range fields["args"].Value.Items {
			x, e := values.construct(v)
			if e != nil {
				return e
			}
			m.Args = append(m.Args, x)
		}
		var e error
		var id talk.DeliveryID
		var pending *talk.Pending
		var decision *talk.Deciding
		ctx, cancel := context.WithCancel(context.Background())
		x.cancels = append(x.cancels, cancel)
		if r.Name == "broadcast" {
			_, e = x.g.Broadcast(m)
		} else if r.Name == "decide-broadcast" {
			var bid talk.BroadcastID
			bid, decision, e = x.g.DecideBroadcast(ctx, m)
			id = talk.DeliveryID(bid)
		} else if target != nil {
			if r.Name == "request" {
				id, pending, e = x.g.Request(ctx, target, m)
			} else if r.Name == "decide" {
				id, decision, e = x.g.Decide(ctx, target, m)
			} else {
				_, e = x.g.Deliver(target, m)
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
				return e
			}
		}
	case "pump":
		clock := fields["clock"].Value
		now := time.Unix(clock.Seconds, int64(clock.Nanos))
		opts := talk.PumpOptions{}
		opts.FuelCap, _ = strconv.ParseInt(fields["fuel-cap"].Raw, 10, 64)
		opts.FuelSlice, _ = strconv.ParseInt(fields["fuel-slice"].Raw, 10, 64)
		result, e := x.g.Pump(now, opts)
		if crossings.err != nil {
			return crossings.err
		}
		if x.sessionObjects != nil {
			x.sessionObjects.Reports(result.Reports)
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
				return e
			}
		}
		if roundTrip {
			nextPump := -1
			explicit := false
			for j := i + 1; j < len(records); j++ {
				if records[j].Input && records[j].Name == "pump" {
					nextPump = j
					break
				}
				if records[j].Input && (records[j].Name == "save" || records[j].Name == "restore") {
					explicit = true
				}
			}
			if nextPump >= 0 && !explicit {
				// Chapter 11 excludes boundaries needing old Host handles.
				crossesOldHandle := false
				pendingIDs := map[string]bool{}
				for _, id := range replay.Pending(x.g) {
					pendingIDs[id] = true
				}
				for _, future := range records[i+1:] {
					if !future.Input {
						continue
					}

					if future.Name == "cancel-delivery" && deliveries[future.IDs[0]] != nil {
						crossesOldHandle = true
					}
					for _, field := range future.Fields {
						if values.hasReceivedFunction(field.Value) {
							crossesOldHandle = true
						}
					}
					if (future.Name == "answer" || future.Name == "fail") && operations.calls[talk.CallID(future.IDs[0])] != nil && !pendingIDs[future.IDs[0]] {
						crossesOldHandle = true
					}

				}
				if crossesOldHandle || x.sessionObjects != nil && x.sessionObjects.CrossesHandles() {
					return nil
				}
				// Save must still be attempted at a live-effect boundary.
				crossings.hidden = true
				before := x.g.Inspect()
				counters := map[string]talk.Counters{}
				for _, view := range before.Scripts {
					counters[view.Name] = x.g.Script(view.Name).Counters()
				}
				crossings.hiddenLines = nil
				saved, saveErr := x.g.Save()
				if saveErr != nil {
					saveLines := append([]string(nil), crossings.hiddenLines...)
					after := x.g.Inspect()
					for _, view := range after.Scripts {
						if counters[view.Name] != x.g.Script(view.Name).Counters() {
							return fmt.Errorf("refused hidden Save changed counters")
						}
					}
					crossings.hidden = false
					if host, ok := saveErr.(*talk.HostError); !ok || host.Code != talk.EffectsPending {
						return saveErr
					}
					if len(saveLines) != 2 || !strings.HasPrefix(saveLines[0], "> save ") || saveLines[1] != `refused code="effects pending"` {
						return fmt.Errorf("refused hidden Save emitted execution records: %v", saveLines)
					}
					if !reflect.DeepEqual(before, after) {
						return fmt.Errorf("refused hidden Save changed execution state")
					}
					return nil
				}
				selected := []*talk.Library{}
				for _, l := range libraries {
					selected = append(selected, l)
				}
				next, result, restoreErr := core.Restore(saved, talk.RestoreOptions{Trace: crossings, OnReady: gReady(ready), Libraries: selected, Grants: func(script, name string) *talk.Grant {
					grants, _ := operations.grants(setups[script])
					return grants[name]
				}, Resolve: func(kind, id string) (any, bool) {
					if x.sessionObjects != nil && !crossings.hidden {
						return x.sessionObjects.Resolve(kind, id)
					}
					o := x.objects[objectRef{kind, id}]
					if o == nil {
						return nil, false
					}
					return o.Native(), true
				}})
				crossings.hidden = false
				if restoreErr != nil {
					return restoreErr
				}

				x.g = next
				if x.sessionObjects != nil {
					x.sessionObjects.Attach(next)
				}
				x.objects = restoredObjects(x.g, x.objects)
				values.objects = x.objects
				for _, p := range result.Pending {
					call, err := x.g.Settle(p.ID, talk.Settlement{Adopt: true})
					if err != nil {
						return err
					}
					operations.calls[p.ID] = call
					crossings.adopted[string(p.ID)] = true
				}
			}
		}
	case "vars":
		view := x.g.Inspect()
		if x.sessionObjects != nil {
			x.sessionObjects.Snapshot(view)
		}
		for _, script := range view.Scripts {
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
		s := x.g.Script(r.IDs[0])
		if s == nil {
			return fmt.Errorf("unknown Script %s", r.IDs[0])
		}
		s.Counters()
	}
	return nil
}

// Refused admissions are traced immediately; accepted inputs are traced only
// when the Pump drains them. Queue the accepted inputs before retrying mailbox
// inputs, while keeping their order and emitting the original Trace order.
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
			o.Set |= talk.OverrideFuelPerRun
		case "allocPerRun":
			o.AllocPerRun = n
			o.Set |= talk.OverrideAllocPerRun
		case "maxWait":
			o.MaxWait = time.Duration(n) * time.Millisecond
			o.Set |= talk.OverrideMaxWait
		case "maxJoin":
			o.MaxJoin = int(n)
			o.Set |= talk.OverrideMaxJoin
		}
	}
	return o
}

func gReady(ready chan struct{}) func() {
	return func() {
		select {
		case ready <- struct{}{}:
		default:
		}
	}
}

func fieldIDs(f Field) []string {
	s := strings.TrimSuffix(strings.TrimPrefix(f.Raw, "["), "]")
	if s == "" {
		return nil
	}
	return strings.Split(s, ", ")
}
