package northtalk

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

type saveHeader struct {
	Family, Format, Name, Fingerprint string
	Versions                          Versions
	Save                              int64
	Libraries                         map[string][32]byte
	Objects                           []savedObject
	Stale                             []savedStale
	Scripts                           []struct {
		Name, Source string
		Extensions   []string
		Limits       Limits
		Grants       []savedGrant
		Owner        *ObjectRef
		Objects      map[string]ObjectRef
		Docs         []string
	}
}

// Restore checks declarations before rehydrating frames. Host bindings and
// futures are rebuilt separately from the saved plain machine data.
func (c *Core) Restore(save []byte, o RestoreOptions) (_ *Group, result RestoreResult, err error) {
	var g *Group
	defer func() {
		if err != nil {
			result.Reports = nil
		}
		if err != nil && o.Trace != nil {
			code := InvalidSave
			if host, ok := err.(*HostError); ok {
				code = host.Code
			}
			o.Trace.Record("refused code=" + corevalue.DisplayText(string(code)))
		}
	}()
	invalid := func(detail string) error { return &HostError{InvalidSave, detail} }
	if o.Mismatch != RejectMismatch && o.Mismatch != VariablesOnly {
		return nil, result, &HostError{InvalidValue, "invalid mismatch policy"}
	}
	var envelope struct{ Hash, Payload string }
	if e := json.Unmarshal(save, &envelope); e != nil {
		return nil, result, invalid(e.Error())
	}
	payload := []byte(envelope.Payload)
	hash := sha256.Sum256(payload)
	if envelope.Hash != fmt.Sprintf("%x", hash) {
		return nil, result, invalid("snapshot checksum differs")
	}
	var header saveHeader
	if e := json.Unmarshal(payload, &header); e != nil {
		return nil, result, invalid(e.Error())
	}
	if header.Family != "northtalk-go" || header.Format != CoreVersions().SaveFormat || header.Save <= 0 {
		return nil, result, invalid("unreadable Core family or save format")
	}
	name := o.Name
	if name == "" {
		name = header.Name
	}
	g = c.NewGroup(GroupOptions{Name: name})
	refs := map[string]any{"group": g}
	mismatch := header.Versions.Language != CoreVersions().Language || header.Versions.CostModel != CoreVersions().CostModel
	for _, l := range o.Libraries {
		if l == nil {
			return nil, result, &HostError{InvalidValue, "nil Library"}
		}
		g.libraries[l.Name()] = l
	}
	withheld := []string{}
	for _, name := range sortedKeys(header.Libraries) {
		id := header.Libraries[name]
		if l := g.libraries[name]; l == nil || l.id != id {
			mismatch = true
			if l == nil {
				withheld = append(withheld, name)
			}
		}
	}
	for _, obj := range header.Objects {
		c.mu.Lock()
		kind := c.objectKinds[obj.Ref.Kind]
		c.mu.Unlock()
		if kind == nil {
			return nil, result, &HostError{SaveMismatch, "Object Kind is no longer defined"}
		}
		if _, e := g.Object(kind, obj.Ref.ID, nil); e != nil {
			return nil, result, invalid(e.Error())
		}
	}
	obj := func(ref *ObjectRef) *Object {
		if ref == nil {
			return nil
		}
		return g.objects[objectKey{ref.Kind, ref.ID}]
	}
	unbound := []string{}
	rebound := map[string]map[string]bool{}
	for _, ss := range header.Scripts {
		grants := map[string]*Grant{}
		rebound[ss.Name] = map[string]bool{}
		for _, sg := range ss.Grants {
			placeholder := &Grant{definition: &CapabilityDef{name: sg.Capability, ops: map[string]Operation{}}, operations: map[string]bool{}}
			for _, op := range sg.Operations {
				placeholder.definition.ops[op.Name] = op.operation()
				placeholder.operations[op.Name] = true
			}
			var offered *Grant
			if o.Grants != nil {
				offered = o.Grants(ss.Name, sg.Name)
			}
			selected := placeholder
			if offered != nil && offered.definition != nil {
				selected = &Grant{definition: offered.definition, binding: offered.binding, coordinator: offered.coordinator, operations: map[string]bool{}}
				for _, op := range sg.Operations {
					if offered.operations[op.Name] {
						selected.operations[op.Name] = true
					}
				}
				if !bytes.Equal(jsonData(grantData(selected)), jsonData(grantData(placeholder))) {
					mismatch = true
				}
				rebound[ss.Name][sg.Name] = true
			} else {
				unbound = append(unbound, ss.Name+"."+sg.Name)
			}
			grants[sg.Name] = selected
		}
		bindings := map[string]*Object{}
		for name, ref := range ss.Objects {
			bindings[name] = obj(&ref)
			if bindings[name] == nil {
				return nil, result, invalid("unknown well-known Object")
			}
		}
		s, e := g.Load(LoadOptions{Name: ss.Name, Source: ss.Source, Grants: grants, Limits: ss.Limits, Owner: obj(ss.Owner), Objects: bindings})
		if e != nil {
			if mismatch && o.Mismatch == RejectMismatch {
				return nil, result, &HostError{SaveMismatch, "declarations differ"}
			}
			return nil, result, e
		}
		for _, source := range ss.Extensions {
			if e := s.Extend(source); e != nil {
				return nil, result, e
			}
		}
		for _, sg := range ss.Grants {
			s.grants[sg.Name].revoked = sg.Revoked || !rebound[ss.Name][sg.Name]
			s.grants[sg.Name].disabled = sg.Disabled
		}
		refs["script/"+ss.Name] = s.state
	}
	for _, entry := range header.Objects {
		object := obj(&entry.Ref)
		object.parent = obj(entry.Parent)
		object.owner = g.script(entry.Owner)
		if entry.Parent != nil && object.parent == nil {
			return nil, result, invalid("unknown Object parent")
		}
	}
	mismatch = mismatch || fmt.Sprintf("%x", g.fingerprint()) != header.Fingerprint
	mode := "full"
	if mismatch {
		mode = "variables-only"
	}
	restoreFields := map[string]string{"from": fmt.Sprintf("s%d", header.Save), "fingerprint": header.Fingerprint, "mode": mode}
	if o.Mismatch == VariablesOnly {
		restoreFields["mismatch"] = "variables-only"
	}
	if len(withheld) > 0 {
		restoreFields["withheld"] = "[" + strings.Join(withheld, ", ") + "]"
	}
	if len(unbound) > 0 {
		restoreFields["unbound"] = "[" + strings.Join(unbound, ", ") + "]"
	}
	if mismatch && o.Mismatch == RejectMismatch {
		if o.Trace != nil {
			g.options.Trace = o.Trace
			g.record("restore", true, nil, restoreFields)
		}
		return nil, result, &HostError{SaveMismatch, "saved declarations or versions differ"}
	}
	for _, entry := range header.Objects {
		object := obj(&entry.Ref)
		var native any
		ok := false
		if o.Resolve != nil {
			native, ok = o.Resolve(entry.Ref.Kind, entry.Ref.ID)
		}
		object.native = native
		object.disposed.Store(entry.Disposed || !ok)
		if !ok {
			result.Disposed = append(result.Disposed, entry.Ref)
		}
	}
	for name, l := range g.libraries {
		refs["library/"+name] = l.state
	}
	for index, stale := range header.Stale {
		refs["stale/"+strconv.Itoa(index)] = &machine.State{Unit: lower.StaleUnit(stale.Name, stale.Docs), Group: g, Gone: true}
	}
	if mismatch {
		// Saved Function Values outlive their code, but keep its documentation.
		docs := map[string][]string{}
		for _, s := range header.Scripts {
			docs[s.Name] = s.Docs
		}
		for _, s := range g.scripts {
			refs["script/"+s.name] = &machine.State{Unit: lower.StaleUnit(s.state.Unit.Name, docs[s.name]), Group: g, Gone: true}
		}
	}
	codec := g.codec(nil, func(key string) (any, bool) { v, ok := refs[key]; return v, ok })
	var data savedGroup
	if e := codec.Unmarshal(payload, &data); e != nil {
		return nil, result, invalid(e.Error())
	}
	if e := validateSavedAccounting(data); e != nil {
		return nil, result, invalid(e.Error())
	}
	g.clock = data.Clock
	g.accounting = data.Accounting
	for _, row := range g.accounting.Runs {
		row.Reported = false
	}
	for _, row := range g.accounting.Roots {
		row.Reported = ""
	}
	g.nextDelivery = data.Delivery
	g.nextBroadcast = data.Broadcast
	g.nextTimer = data.Timer
	g.nextSave = data.Save
	for _, report := range data.Deferred {
		report := report
		g.deferredDecisions = append(g.deferredDecisions, &report)
	}
	decisions := make([]*Deciding, len(data.Decisions))
	for i, row := range data.Decisions {
		decisions[i] = &Deciding{done: make(chan struct{}), sealed: row.Sealed, result: row.Result, recipient: row.Recipient}
	}
	broadcasts := make([]*broadcastDecision, len(data.Broadcasts))
	for i, row := range data.Broadcasts {
		if row.Future < 0 || row.Future >= len(decisions) {
			return nil, result, invalid("invalid Broadcast Decision")
		}
		broadcasts[i] = &broadcastDecision{id: row.ID, future: decisions[row.Future], remaining: row.Remaining, results: row.Results}
	}
	for i, row := range data.Decisions {
		if row.Broadcast >= 0 {
			if row.Broadcast >= len(broadcasts) {
				return nil, result, invalid("unknown Broadcast")
			}
			decisions[i].broadcast = broadcasts[row.Broadcast]
		}
	}
	var deliveryData func(savedDelivery) (delivery, error)
	deliveryData = func(row savedDelivery) (delivery, error) {
		d := delivery{ancestry: row.Ancestry, id: row.ID, broadcast: row.Broadcast, script: g.script(row.Script), message: row.Message, cancel: row.Cancel, kind: row.Kind, fields: row.Fields, reason: row.Reason, from: row.From, during: row.During, reply: row.Reply, function: row.Function, target: obj(row.Target), after: obj(row.After), parent: obj(row.Parent), object: obj(row.Object), path: row.Path}
		if row.Decision >= 0 {
			if row.Decision >= len(decisions) {
				return d, invalid("unknown Decision")
			}
			d.decision = decisions[row.Decision]
		}
		if row.Settlement != nil {
			d.settlement = &operationSettlement{value: row.Settlement.Value, err: row.Settlement.Error, fuel: row.Settlement.Fuel, reason: row.Settlement.Reason, restore: row.Settlement.Restore}
		}
		for _, child := range row.Children {
			x, e := deliveryData(child)
			if e != nil {
				return d, e
			}
			d.children = append(d.children, x)
		}
		return d, nil
	}
	runs := map[RunID]*execution{}
	for _, ss := range data.Scripts {
		s := g.script(ss.Name)
		if s == nil {
			return nil, result, invalid("unknown Script")
		}
		s.counters = ss.Counters
		vars := ss.Variables
		if mismatch && ss.Active != "" {
			for _, x := range ss.Runs {
				if x.ID == ss.Active {
					if x.Run == nil {
						return nil, result, invalid("missing active Run")
					}
					vars = x.Run.Base
				}
			}
		}
		if len(vars) != len(ss.VariableNames) {
			return nil, result, invalid("invalid variable slots")
		}
		if mismatch {
			for i, name := range s.state.Unit.Variables {
				if j := slices.Index(ss.VariableNames, name); j >= 0 {
					s.state.Variables[i] = vars[j]
				}
			}
		} else {
			if !slices.Equal(ss.VariableNames, s.state.Unit.Variables) {
				return nil, result, invalid("invalid variable names")
			}
			s.state.Variables = slices.Clone(vars)
		}
		if mismatch && valuesSize(s.state.Variables) > s.limits.PersistentState {
			return nil, result, &HostError{StateTooLarge, "carried Variables exceed Persistent State"}
		}
		if !mismatch {
			s.state.Definitions = ss.Definitions
			s.stopped = ss.Stopped
			s.stopReason = ss.StopReason
			s.reserved = ss.Reserved
			s.debt = ss.Debt
		}
		for _, row := range ss.Runs {
			d, e := deliveryData(row.Delivery)
			if e != nil {
				return nil, result, e
			}
			if mismatch {
				result.DiscardedRuns = append(result.DiscardedRuns, row.ID)
				if row.WaitCall != "" {
					result.AbandonedCalls = append(result.AbandonedCalls, row.WaitCall)
				}
				if row.Run == nil {
					return nil, result, invalid("missing discarded Run")
				}
				if join := row.Run.Join; join != nil && !join.Ready {
					for _, member := range join.Members {
						if member.Reply == nil {
							result.AbandonedCalls = append(result.AbandonedCalls, CallID(member.ID))
						}
					}
				}
				g.accountEnd(&execution{id: row.ID, run: row.Run, delivery: d}, "discarded", "variables-only restore", &result.Reports)
				g.deferDiscardedDecision(d, row.ID)
				continue
			}
			x := &execution{run: row.Run, delivery: d, id: row.ID, handler: row.Handler, clause: row.Clause, how: row.How, deadline: row.Deadline, deadlineAfter: row.DeadlineAfter, timerOrder: row.TimerOrder, parked: row.Parked, deciding: row.Deciding, suspendedOnce: row.SuspendedOnce, segment: row.Segment, calls: row.Calls, raisesWritten: row.RaisesWritten, offersWritten: row.OffersWritten, waitCall: row.WaitCall, abandonCall: row.AbandonCall}
			if x.run == nil || x.run.State != s.state || len(x.run.Base) != len(s.state.Variables) {
				return nil, result, invalid("invalid Run Home or rollback base")
			}
			if x.run.Status < machine.Running || x.run.Status > machine.Stopped {
				return nil, result, invalid("invalid Run status")
			}
			if (x.run.Status == machine.Running || x.run.Status == machine.Preempted || x.run.Status == machine.Suspended || x.run.Status == machine.Parked || x.run.Status == machine.Dispatching) && len(x.run.Frames) == 0 {
				return nil, result, invalid("Run has no frames")
			}
			if x.run.Fuel < 0 || x.run.Alloc < 0 || x.run.CleanupFuel < 0 {
				return nil, result, invalid("negative Run counters")
			}
			for _, f := range x.run.Frames {
				if f.Code == nil || f.Body < 0 || f.Body >= len(f.Code.Unit.Bodies) || f.PC < 0 || f.PC >= len(f.Code.Unit.Bodies[f.Body].Code) {
					return nil, result, invalid("invalid frame")
				}
			}
			for _, f := range x.run.Frames {
				if len(f.Locals) != len(f.Code.Unit.Bodies[f.Body].Checked.Locals) {
					return nil, result, invalid("invalid frame local slots")
				}
				for slot := range f.ReceiverNames {
					if slot < 0 || slot >= len(f.Stack) {
						return nil, result, invalid("invalid receiver token")
					}
				}
			}
			knownCode := map[*machine.State]bool{}
			for _, ref := range refs {
				if state, ok := ref.(*machine.State); ok && !state.Gone {
					knownCode[state] = true
				}
			}
			if err := x.run.ValidateSnapshot(knownCode); err != nil {
				return nil, result, invalid(err.Error())
			}
			x.run.RestoreRecoveryLocals()
			for _, t := range row.Timers {
				x.memberTimers = append(x.memberTimers, memberTimer{t.ID, t.Deadline, t.Order, t.MS})
			}
			runs[x.id] = x
			s.runs = append(s.runs, x)
		}
		if !mismatch {
			s.active = runs[ss.Active]
		}
		for _, item := range ss.Queue {
			if item.Run != "" {
				if !mismatch {
					x := runs[item.Run]
					if x == nil {
						return nil, result, invalid("unknown queued Run")
					}
					s.queue = append(s.queue, workItem{run: x})
				}
			} else {
				d, e := deliveryData(item.Delivery)
				if e != nil {
					return nil, result, e
				}
				if mismatch {
					if d.id != "" {
						result.DroppedMessages = append(result.DroppedMessages, d.id)
					}
					g.accountDrop(d)
					g.deferDiscardedDecision(d, "")
				} else {
					s.queue = append(s.queue, workItem{delivery: d})
				}
			}
		}
	}
	g.calls = map[CallID]*operationCall{}
	g.unsettled = map[CallID]*Call{}
	for _, row := range data.Calls {
		if mismatch {
			if row.Pending {
				result.AbandonedCalls = append(result.AbandonedCalls, row.ID)
			}
			continue
		}
		s, x := g.script(row.Script), runs[row.Run]
		if s == nil || x == nil || s.grants[row.Grant] == nil {
			return nil, result, invalid("unknown pending call Home")
		}
		grant := s.grants[row.Grant]
		op, ok := grant.definition.ops[row.Name]
		if !ok {
			return nil, result, invalid("unknown pending Operation")
		}
		ctx, cancel := operationContext(Suspending)
		call := &Call{group: g, scriptName: s.name, runID: x.id, grantName: row.Grant, binding: grant.binding, id: row.ID, segmentID: row.Segment, now: row.Now, context: ctx}
		g.calls[row.ID] = &operationCall{call: call, cancel: cancel, s: s, x: x, op: op, name: row.Name, pending: row.Pending, args: row.Args, rebound: rebound[s.name][row.Grant]}
		if row.Pending {
			result.Pending = append(result.Pending, PendingCall{row.ID, s.name, row.Grant, OperationRef{grant.definition.name, row.Name}, slices.Clone(row.Args)})
			g.unsettled[row.ID] = call
		}
	}
	for _, row := range data.Inputs {
		d, e := deliveryData(row)
		if e != nil {
			return nil, result, e
		}
		if mismatch {
			if d.id != "" {
				result.DroppedMessages = append(result.DroppedMessages, d.id)
			}
			g.accountDrop(d)
			g.deferDiscardedDecision(d, "")
		} else {
			g.inputs = append(g.inputs, d)
			if d.settlement != nil && d.settlement.restore != nil {
				delete(g.unsettled, d.reply)
			}
		}
	}
	if mismatch {
		for _, row := range data.Unrouted {
			d, e := deliveryData(row)
			if e != nil {
				return nil, result, e
			}
			g.accountDrop(d)
		}
	}
	if !mismatch {
		for _, row := range data.Unrouted {
			d, e := deliveryData(row)
			if e != nil {
				return nil, result, e
			}
			g.unrouted = append(g.unrouted, d)
		}
		for _, row := range data.OrphanReplies {
			d, e := deliveryData(row)
			if e != nil {
				return nil, result, e
			}
			g.orphanReplies = append(g.orphanReplies, d)
		}
	}
	g.restored = !mismatch
	g.settlementsOpen = !mismatch
	slices.SortFunc(result.AbandonedCalls, func(a, b CallID) int { return compareCallID(a, b) })
	result.AbandonedCalls = slices.Compact(result.AbandonedCalls)
	result.VariablesOnly = mismatch
	list := func(xs []string) string { return "[" + strings.Join(xs, ", ") + "]" }
	ids := []string{}
	for _, p := range result.Pending {
		ids = append(ids, string(p.ID))
	}
	if len(ids) > 0 {
		restoreFields["pending"] = list(ids)
	}
	ids = nil
	for _, id := range result.DiscardedRuns {
		ids = append(ids, string(id))
	}
	if len(ids) > 0 {
		restoreFields["discarded"] = list(ids)
	}
	ids = nil
	for _, id := range result.DroppedMessages {
		ids = append(ids, string(id))
	}
	if len(ids) > 0 {
		restoreFields["dropped"] = list(ids)
	}
	ids = nil
	for _, id := range result.AbandonedCalls {
		ids = append(ids, string(id))
	}
	if len(ids) > 0 {
		restoreFields["abandoned"] = list(ids)
	}
	ids = nil
	for _, ref := range result.Disposed {
		ids = append(ids, g.objects[objectKey{ref.Kind, ref.ID}].Value().String())
	}
	if len(ids) > 0 {
		restoreFields["disposed"] = list(ids)
	}
	g.options.OnReady = o.OnReady
	g.options.Trace = o.Trace
	g.flushAccounting(&result.Reports)
	g.record("restore", true, nil, restoreFields)
	return g, result, nil
}

func (g *Group) deferDiscardedDecision(d delivery, run RunID) {
	if d.decision == nil || d.decision.isSealed() {
		return
	}
	name := ""
	if d.script != nil {
		name = d.script.name
	}
	report := &Decided{Delivery: d.id, Broadcast: d.broadcast, Verdict: Undecided, Undecided: []UndecidedBy{{Script: name, Run: run, Outcome: Cancelled}}}
	if d.script == nil {
		report.Undecided = nil
	}
	if r := d.decision.sealReport(report); r != nil {
		g.deferredDecisions = append(g.deferredDecisions, r)
	}
}
