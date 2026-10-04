package northtalk

import (
	"context"
	"errors"
	"fmt"
	coretrace "github.com/odogono/odgn-talk/impl/go/internal/trace"
	"slices"
	"sync"
	"time"

	"github.com/odogono/odgn-talk/impl/go/internal/shape"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

type Mode int

const (
	Immediate Mode = iota
	Suspending
	FireAndForget
)

type Cost struct{ Fuel, Alloc int64 }
type ErrorDecl struct {
	Code   string
	Fields []Field
}
type ScopeDecl struct{ Opens, Abandon, Closes string }
type Operation struct {
	Name         string
	Args         []Shape
	Result       Shape
	Cost         Cost
	Mode         Mode
	MaxPending   time.Duration
	Errors       []ErrorDecl
	Scope        *ScopeDecl
	SegmentBound bool
	Do           func(c *Call, args []Value) (Value, error)
	Start        func(c *Call, args []Value) error
	Fire         func(c *Call, args []Value) error
}

// operationChecks are private refinements installed only by Standard factories.
// Ordinary Host declarations cannot opt into catalogue failures or Core checks.
type operationChecks struct {
	arguments func([]corevalue.Value) *corevalue.Value
	result    func(corevalue.Value) bool
	failure   func(string, corevalue.Value) bool
}
type CapabilityDef struct {
	name   string
	ops    map[string]Operation
	checks map[string]operationChecks
}
type Grant struct {
	definition *CapabilityDef
	operations map[string]bool
	binding    any
	revoked    bool
}

func (d *CapabilityDef) Name() string { return d.name }
func (c *Core) DefineCapability(name string, ops ...Operation) (*CapabilityDef, error) {
	d := &CapabilityDef{name: name, ops: map[string]Operation{}}
	for _, op := range ops {
		invalid := func(detail string) (*CapabilityDef, error) { return nil, &HostError{InvalidValue, detail} }
		if op.Name == "" || slices.Contains([]string{"ask", "tell", "send", "wait"}, op.Name) {
			return invalid("invalid Operation name")
		}
		if _, ok := d.ops[op.Name]; ok {
			return invalid("duplicate Operation name")
		}
		if op.Cost.Fuel < 0 || op.Cost.Alloc < 0 || op.Cost.Fuel > 9007199254740991 || op.Cost.Alloc > 9007199254740991 {
			return invalid("invalid Operation cost")
		}
		if op.Scope != nil || op.SegmentBound {
			return invalid("Scoped and Segment-bound Operations are not available")
		}
		if op.MaxPending < 0 || op.MaxPending%time.Millisecond != 0 || op.Mode != Suspending && op.MaxPending != 0 {
			return invalid("invalid maxPending")
		}
		if op.Mode == Immediate && (op.Do == nil || op.Start != nil || op.Fire != nil) || op.Mode == Suspending && (op.Start == nil || op.Do != nil || op.Fire != nil) || op.Mode == FireAndForget && (op.Fire == nil || op.Do != nil || op.Start != nil) || op.Mode < Immediate || op.Mode > FireAndForget {
			return invalid("Operation implementation does not match its mode")
		}
		for _, arg := range op.Args {
			if !validShape(arg.inner) {
				return invalid("invalid argument Shape")
			}
		}
		if op.Result.inner.Kind != "" && !validShape(op.Result.inner) {
			return invalid("invalid result Shape")
		}
		op.Args = slices.Clone(op.Args)
		if op.Errors != nil {
			op.Errors = append([]ErrorDecl{}, op.Errors...)
		}
		for i := range op.Errors {
			op.Errors[i].Fields = slices.Clone(op.Errors[i].Fields)
			for _, f := range op.Errors[i].Fields {
				if !validShape(f.Shape.inner) {
					return invalid("invalid error field Shape")
				}
			}
		}
		d.ops[op.Name] = op
	}
	return d, nil
}
func validShape(s shape.Shape) bool {
	if s.Kind == "" {
		return false
	}
	if (s.Kind == "list" || s.Kind == "optional") && len(s.Of) != 1 || s.Kind == "oneOf" && len(s.Of) == 0 {
		return false
	}
	for _, x := range s.Of {
		if !validShape(x) {
			return false
		}
	}
	seen := map[string]bool{}
	for _, f := range s.Fields {
		if seen[f.Key] || !validShape(f.Shape) {
			return false
		}
		seen[f.Key] = true
	}
	return true
}
func (d *CapabilityDef) Grant(ops []string, binding any) (*Grant, error) {
	g := &Grant{definition: d, operations: map[string]bool{}, binding: binding}
	for _, name := range ops {
		if _, ok := d.ops[name]; !ok {
			return nil, &HostError{InvalidValue, "unknown Operation: " + name}
		}
		g.operations[name] = true
	}
	return g, nil
}
func (d *CapabilityDef) GrantAll(binding any) *Grant {
	names := make([]string, 0, len(d.ops))
	for name := range d.ops {
		names = append(names, name)
	}
	g, _ := d.Grant(names, binding)
	return g
}

var ErrLimit error = errors.New("the Run cannot cover this charge")

type Call struct {
	mu         sync.Mutex
	group      *Group
	scriptName string
	runID      RunID
	grantName  string
	binding    any
	id         CallID
	segmentID  string
	now        time.Time
	context    context.Context
	starting   bool
	reached    bool
	charged    int64
	charge     func(int64) bool // valid only during this Host crossing
}

func (c *Call) ID() CallID               { return c.id }
func (c *Call) ScriptName() string       { return c.scriptName }
func (c *Call) Group() *Group            { return c.group }
func (c *Call) RunID() RunID             { return c.runID }
func (c *Call) GrantName() string        { return c.grantName }
func (c *Call) SegmentID() string        { return c.segmentID }
func (c *Call) ScopeName() string        { return "" }
func (c *Call) Automatic() bool          { return false }
func (c *Call) Binding() any             { return c.binding }
func (c *Call) Now() time.Time           { return c.now }
func (c *Call) Context() context.Context { return c.context }
func (c *Call) Charge(fuel int64) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.starting || fuel < 0 || fuel > 9007199254740991 {
		return &HostError{InvalidValue, "Charge must be a nonnegative safe integer while starting"}
	}
	if !c.charge(fuel) {
		c.reached = true
		return ErrLimit
	}
	c.charged += fuel
	return nil
}
func (c *Call) finish() { c.mu.Lock(); defer c.mu.Unlock(); c.starting = false; c.charge = nil }
func (s *Script) Grants() map[string][]string {
	if e := s.group.beginWorker(); e != nil {
		panic(e)
	}
	defer s.group.endWorker()
	out := map[string][]string{}
	for name, g := range s.grants {
		ops := make([]string, 0, len(g.operations))
		for op := range g.operations {
			ops = append(ops, op)
		}
		slices.Sort(ops)
		out[name] = ops
	}
	return out
}
func (s *Script) Revoke(grantName string) {
	g := s.group
	g.mu.Lock()
	g.inputs = append(g.inputs, delivery{kind: "revoke", script: s, fields: map[string]string{"grant": grantName}})
	ready := g.options.OnReady
	g.mu.Unlock()
	if ready != nil {
		ready()
	}
}

func modeName(m Mode) string { return []string{"immediate", "suspending", "fire-and-forget"}[m] }

// Answer queues a suspending call's settlement for the next Pump.
func (c *Call) Answer(v Value) { c.AnswerWithCost(v, 0) }

// AnswerWithCost charges late Fuel with result conversion on resumption.
func (c *Call) AnswerWithCost(v Value, fuel int64) {
	if fuel < 0 || fuel > 9007199254740991 {
		panic(&HostError{InvalidValue, "invalid late Fuel"})
	}
	c.queueSettlement("answer", v, nil, fuel)
}

// Fail queues a copied ScriptError; nil fails as host error.
func (c *Call) Fail(e *ScriptError) {
	var copy *ScriptError
	if e != nil {
		clone := *e
		copy = &clone
	}
	c.queueSettlement("fail", Nothing, copy, 0)
}
func (c *Call) queueSettlement(kind string, v Value, e *ScriptError, fuel int64) {
	g := c.group
	fields := map[string]string{}
	if kind == "answer" {
		fields["value"] = coretrace.Display(v.inner)
		if fuel != 0 {
			fields["fuel"] = fmt.Sprint(fuel)
		}
	} else {
		fields["error"] = coretrace.Display(hostFailureValue(e))
	}
	g.mu.Lock()
	g.inputs = append(g.inputs, delivery{kind: kind, reply: c.id, fields: fields, settlement: &operationSettlement{value: v, err: e, fuel: fuel}})
	ready := g.options.OnReady
	g.mu.Unlock()
	if ready != nil {
		ready()
	}
}
