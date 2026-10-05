package northtalk

import (
	"crypto/sha256"
	"fmt"
	"math/big"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	"github.com/odogono/odgn-talk/impl/go/internal/shape"
	"github.com/odogono/odgn-talk/impl/go/internal/snapshot"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

type RestoreOptions struct {
	Name      string
	OnReady   func()
	Trace     TraceSink
	Libraries []*Library
	Grants    func(script, name string) *Grant
	Resolve   func(kind, id string) (native any, ok bool)
	Mismatch  MismatchPolicy
}
type MismatchPolicy int

const (
	RejectMismatch MismatchPolicy = iota
	VariablesOnly
)

type RestoreResult struct {
	VariablesOnly   bool
	Pending         []PendingCall
	DiscardedRuns   []RunID
	Disposed        []ObjectRef
	DroppedMessages []DeliveryID
	AbandonedCalls  []CallID
}
type ObjectRef struct{ Kind, ID string }
type PendingCall struct {
	ID            CallID
	Script, Grant string
	Operation     OperationRef
	Args          []Value
}
type Settlement struct {
	Answer         *Value
	Fail           *ScriptError
	Reissue, Adopt bool
}

type savedGrant struct {
	Name, Capability  string
	Operations        []savedOperation
	Revoked, Disabled bool
}
type savedOperation struct {
	Name         string
	Args         []shape.Shape
	Result       shape.Shape
	Cost         Cost
	Mode         Mode
	MaxPending   time.Duration
	Errors       []savedError
	Scope        *ScopeDecl
	SegmentBound bool
}
type savedError struct {
	Code   string
	Fields []shape.Field
}

func saveOperation(op Operation) savedOperation {
	args := []shape.Shape{}
	for _, a := range op.Args {
		args = append(args, a.inner)
	}
	var es []savedError
	if op.Errors != nil {
		es = []savedError{}
		for _, e := range op.Errors {
			fs := []shape.Field{}
			for _, f := range e.Fields {
				fs = append(fs, shape.Field{Key: f.Key, Shape: f.Shape.inner, Optional: f.Optional})
			}
			es = append(es, savedError{e.Code, fs})
		}
	}
	return savedOperation{op.Name, args, op.Result.inner, op.Cost, op.Mode, op.MaxPending, es, op.Scope, op.SegmentBound}
}
func (s savedOperation) operation() Operation {
	op := Operation{Name: s.Name, Result: Shape{s.Result}, Cost: s.Cost, Mode: s.Mode, MaxPending: s.MaxPending, Scope: s.Scope, SegmentBound: s.SegmentBound}
	for _, a := range s.Args {
		op.Args = append(op.Args, Shape{a})
	}
	if s.Errors != nil {
		op.Errors = []ErrorDecl{}
		for _, e := range s.Errors {
			fs := []Field{}
			for _, f := range e.Fields {
				fs = append(fs, Field{Key: f.Key, Shape: Shape{f.Shape}, Optional: f.Optional})
			}
			op.Errors = append(op.Errors, ErrorDecl{e.Code, fs})
		}
	}
	return op
}

type savedGroup struct {
	Family, Format                  string
	Versions                        Versions
	Name, Fingerprint               string
	Save                            int64
	Clock                           time.Time
	Delivery, Broadcast, Timer      int64
	Libraries                       map[string][32]byte
	Scripts                         []savedScript
	Objects                         []savedObject
	Calls                           []savedCall
	Inputs, Unrouted, OrphanReplies []savedDelivery
	Decisions                       []savedDecision
	Broadcasts                      []savedBroadcast
	Deferred                        []Decided
	Stale                           []string
}
type savedScript struct {
	Name, Source           string
	Extensions             []string
	Identity               [32]byte
	Limits                 Limits
	Grants                 []savedGrant
	Owner                  *ObjectRef
	Objects                map[string]ObjectRef
	VariableNames          []string
	Variables, Definitions []corevalue.Value
	Runs                   []savedExecution
	Queue                  []savedWork
	Active                 RunID
	Counters               Counters
	Stopped                bool
	StopReason             string
	Reserved               int
	Debt                   int64
}
type savedObject struct {
	Ref      ObjectRef
	Parent   *ObjectRef
	Owner    string
	Disposed bool
}
type savedExecution struct {
	Run                   *machine.Run
	Delivery              savedDelivery
	ID                    RunID
	Handler               string
	Clause                int
	How                   string
	Deadline              *big.Int
	Timers                []savedTimer
	TimerOrder            int64
	Parked, Deciding      bool
	Segment               int
	Calls                 int64
	RaisesWritten         int
	WaitCall, AbandonCall CallID
}
type savedTimer struct {
	ID        string
	Deadline  *big.Int
	Order, MS int64
}
type savedWork struct {
	Run      RunID
	Delivery savedDelivery
}
type savedDelivery struct {
	ID                            DeliveryID
	Broadcast                     BroadcastID
	Script                        string
	Message                       Message
	Decision                      int
	Children                      []savedDelivery
	Cancel                        DeliveryID
	Kind                          string
	Fields                        map[string]string
	Reason                        string
	From                          RunID
	During                        *corevalue.Value
	Reply                         CallID
	Function                      *corevalue.Value
	Target, After, Parent, Object *ObjectRef
	Path                          bool
	Settlement                    *savedSettlement
}
type savedSettlement struct {
	Value   Value
	Error   *ScriptError
	Fuel    int64
	Reason  string
	Restore *Settlement
}
type savedDecision struct {
	Sealed    bool
	Result    *Decided
	Broadcast int
	Recipient int
}
type savedBroadcast struct {
	ID                BroadcastID
	Future, Remaining int
	Results           []*Decided
}
type savedCall struct {
	ID                  CallID
	Script, Grant, Name string
	Run                 RunID
	Pending             bool
	Args                []Value
	Now                 time.Time
	Segment             string
	Rebound             bool
}

func objectRef(o *Object) *ObjectRef {
	if o == nil {
		return nil
	}
	return &ObjectRef{o.kind.name, o.id}
}
func (g *Group) codec(ref func(any) (string, bool), resolve func(string) (any, bool)) snapshot.Codec {
	return snapshot.Codec{Reference: ref, Resolve: resolve, Function: func(fn *corevalue.FunctionData) error {
		code, codeOK := fn.CodeState.(*machine.State)
		home, homeOK := fn.Owner.(*machine.State)
		if !codeOK || !homeOK || code == nil || home == nil || fn.Group != g || home.Group != g || code.Group != nil && code.Group != g {
			return fmt.Errorf("invalid Function Home or code")
		}
		if !code.Gone && (code.Unit == nil || fn.Body < 0 || fn.Body >= len(code.Unit.Bodies)) {
			return fmt.Errorf("invalid Function body")
		}
		return nil
	}, ValueType: reflect.TypeFor[Value](), UnwrapValue: func(v any) corevalue.Value { return v.(Value).inner }, WrapValue: func(v corevalue.Value) any { return Value{v} }, Object: func(kind, id string) (corevalue.Value, error) {
		o := g.objects[objectKey{kind, id}]
		if o == nil {
			return corevalue.Value{}, fmt.Errorf("unknown Object")
		}
		return o.Value().inner, nil
	}}
}

// Save snapshots a Quiescent Group without draining Host Inputs or closing effects.
func (g *Group) Save() ([]byte, error) {
	if err := g.beginWorker(); err != nil {
		return nil, err
	}
	defer g.endWorker()
	g.nextSave++
	g.record("save", true, []string{fmt.Sprintf("s%d", g.nextSave)}, nil)
	if g.effectUnknown {
		return nil, g.refuse(EffectsPending, "Group has unresolved external effects")
	}
	for _, s := range g.scripts {
		for _, x := range s.runs {
			if len(x.scopes) > 0 || x.participant != nil {
				return nil, g.refuse(EffectsPending, "Run has live Host effects")
			}
		}
	}
	g.mu.Lock()
	data := savedGroup{Family: "northtalk-go", Format: CoreVersions().SaveFormat, Versions: CoreVersions(), Name: g.options.Name, Fingerprint: fmt.Sprintf("%x", g.fingerprint()), Save: g.nextSave, Clock: g.clock, Delivery: g.nextDelivery, Broadcast: g.nextBroadcast, Timer: g.nextTimer, Libraries: map[string][32]byte{}}
	refs := map[any]string{g: "group"}
	for _, s := range g.scripts {
		refs[s.state] = "script/" + s.name
	}
	for name, l := range g.libraries {
		data.Libraries[name] = l.id
		refs[l.state] = "library/" + name
	}
	decisions := map[*Deciding]int{}
	broadcasts := map[*broadcastDecision]int{}
	var decision func(*Deciding) int
	decision = func(d *Deciding) int {
		if d == nil {
			return -1
		}
		if n, ok := decisions[d]; ok {
			return n
		}
		n := len(data.Decisions)
		decisions[d] = n
		data.Decisions = append(data.Decisions, savedDecision{})
		row := savedDecision{Sealed: d.sealed, Result: d.result, Broadcast: -1, Recipient: d.recipient}
		if b := d.broadcast; b != nil {
			index, ok := broadcasts[b]
			if !ok {
				index = len(data.Broadcasts)
				broadcasts[b] = index
				data.Broadcasts = append(data.Broadcasts, savedBroadcast{ID: b.id, Remaining: b.remaining, Results: b.results})
				data.Broadcasts[index].Future = decision(b.future)
			}
			row.Broadcast = index
		}
		data.Decisions[n] = row
		return n
	}
	var deliveryData func(delivery) savedDelivery
	deliveryData = func(d delivery) savedDelivery {
		row := savedDelivery{ID: d.id, Broadcast: d.broadcast, Message: d.message, Decision: decision(d.decision), Cancel: d.cancel, Kind: d.kind, Fields: d.fields, Reason: d.reason, From: d.from, During: d.during, Reply: d.reply, Function: d.function, Target: objectRef(d.target), After: objectRef(d.after), Parent: objectRef(d.parent), Object: objectRef(d.object), Path: d.path}
		if d.script != nil {
			row.Script = d.script.name
		}
		if d.settlement != nil {
			row.Settlement = &savedSettlement{d.settlement.value, d.settlement.err, d.settlement.fuel, d.settlement.reason, d.settlement.restore}
		}
		for _, child := range d.children {
			row.Children = append(row.Children, deliveryData(child))
		}
		return row
	}
	for _, s := range g.scripts {
		row := savedScript{Name: s.name, Source: s.source, Extensions: s.extensions, Identity: s.identity, Limits: s.limits, Owner: objectRef(s.owner), Objects: map[string]ObjectRef{}, VariableNames: s.state.Unit.Variables, Variables: s.state.Variables, Definitions: s.state.Definitions, Counters: s.counters, Stopped: s.stopped, StopReason: s.stopReason, Reserved: s.reserved, Debt: s.debt}
		for n, v := range s.state.Objects {
			row.Objects[n] = ObjectRef{v.Object.Kind, v.Object.ID}
		}
		for _, name := range sortedKeys(s.grants) {
			grant := s.grants[name]
			sg := savedGrant{Name: name, Capability: grant.definition.name, Revoked: grant.revoked, Disabled: grant.disabled}
			for _, op := range sortedKeys(grant.operations) {
				if grant.operations[op] {
					sg.Operations = append(sg.Operations, saveOperation(grant.definition.ops[op]))
				}
			}
			row.Grants = append(row.Grants, sg)
		}
		for _, x := range s.runs {
			sx := savedExecution{Run: x.run, Delivery: deliveryData(x.delivery), ID: x.id, Handler: x.handler, Clause: x.clause, How: x.how, Deadline: x.deadline, TimerOrder: x.timerOrder, Parked: x.parked, Deciding: x.deciding, Segment: x.segment, Calls: x.calls, RaisesWritten: x.raisesWritten, WaitCall: x.waitCall, AbandonCall: x.abandonCall}
			for _, t := range x.memberTimers {
				sx.Timers = append(sx.Timers, savedTimer{t.id, t.deadline, t.order, t.ms})
			}
			row.Runs = append(row.Runs, sx)
		}
		for _, w := range s.queue {
			if w.run != nil {
				row.Queue = append(row.Queue, savedWork{Run: w.run.id})
			} else {
				row.Queue = append(row.Queue, savedWork{Delivery: deliveryData(w.delivery)})
			}
		}
		if s.active != nil {
			row.Active = s.active.id
		}
		data.Scripts = append(data.Scripts, row)
	}
	keys := []objectKey{}
	for key := range g.objects {
		keys = append(keys, key)
	}
	slices.SortFunc(keys, func(a, b objectKey) int {
		if n := cmpString(a.kind, b.kind); n != 0 {
			return n
		}
		return cmpString(a.id, b.id)
	})
	for _, key := range keys {
		o := g.objects[key]
		row := savedObject{Ref: *objectRef(o), Parent: objectRef(o.parent), Disposed: o.disposed.Load()}
		if o.owner != nil {
			row.Owner = o.owner.name
		}
		data.Objects = append(data.Objects, row)
	}
	for _, id := range orderedCalls(g.calls) {
		p := g.calls[id]
		data.Calls = append(data.Calls, savedCall{ID: id, Script: p.s.name, Grant: p.call.grantName, Name: p.name, Run: p.x.id, Pending: p.pending, Args: p.args, Now: p.call.now, Segment: p.call.segmentID, Rebound: p.rebound})
	}
	for _, d := range g.inputs {
		data.Inputs = append(data.Inputs, deliveryData(d))
	}
	for _, d := range g.unrouted {
		data.Unrouted = append(data.Unrouted, deliveryData(d))
	}
	for _, d := range g.orphanReplies {
		data.OrphanReplies = append(data.OrphanReplies, deliveryData(d))
	}
	for _, d := range g.deferredDecisions {
		data.Deferred = append(data.Deferred, *d)
	}
	g.mu.Unlock()
	codec := g.codec(func(v any) (string, bool) {
		if reflect.TypeOf(v).Comparable() {
			if key, ok := refs[v]; ok {
				return key, true
			}
		}
		if state, ok := v.(*machine.State); ok {
			key := "stale/" + strconv.Itoa(len(data.Stale))
			data.Stale = append(data.Stale, state.Unit.Name)
			refs[v] = key
			return key, true
		}
		return "", false
	}, nil)
	// References discovered while encoding are included in a second pass.
	payload, err := codec.Marshal(data)
	if err != nil {
		return nil, err
	}
	payload, err = codec.Marshal(data)
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256(payload)
	return jsonData(struct {
		Hash    string `json:"hash"`
		Payload string `json:"payload"`
	}{fmt.Sprintf("%x", hash), string(payload)}), nil
}
func sortedKeys[V any](m map[string]V) []string {
	keys := []string{}
	for key := range m {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}
func orderedCalls(m map[CallID]*operationCall) []CallID {
	ids := []CallID{}
	for id := range m {
		ids = append(ids, id)
	}
	slices.SortFunc(ids, compareCallID)
	return ids
}
func compareCallID(a, b CallID) int {
	as, ar, ac := splitCall(a)
	bs, br, bc := splitCall(b)
	if n := cmpString(as, bs); n != 0 {
		return n
	}
	if ar < br {
		return -1
	}
	if ar > br {
		return 1
	}
	if ac < bc {
		return -1
	}
	if ac > bc {
		return 1
	}
	return 0
}
func splitCall(id CallID) (string, int64, int64) {
	at := strings.LastIndex(string(id), "/r")
	if at < 0 {
		return string(id), 0, 0
	}
	script, tail := string(id)[:at], string(id)[at+2:]
	run, call, _ := strings.Cut(tail, ".c")
	r, _ := strconv.ParseInt(run, 10, 64)
	c, _ := strconv.ParseInt(call, 10, 64)
	return script, r, c
}
