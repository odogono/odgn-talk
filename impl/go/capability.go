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
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
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
	arguments func([]corevalue.Value, any) *corevalue.Value
	result    func(corevalue.Value, []corevalue.Value) bool
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
	disabled   bool
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
		if op.SegmentBound {
			return invalid("Segment-bound Operations are not available")
		}
		if op.Scope != nil {
			scope := *op.Scope
			if op.Mode != Immediate || !validScopeDecl(scope) {
				return invalid("invalid scope declaration")
			}
			op.Scope = &scope
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
	abandons := map[string]string{}
	for _, op := range d.ops {
		if op.Scope == nil || op.Scope.Opens == "" {
			continue
		}
		s := op.Scope
		target, ok := d.ops[s.Abandon]
		if !ok || target.Scope == nil || target.Scope.Closes != s.Opens || target.Mode != Immediate || len(target.Args) != 0 || target.Result.inner.Kind != "kind" || target.Result.inner.Name != "nothing" {
			return nil, &HostError{InvalidValue, "invalid scope abandonment Operation"}
		}
		if previous := abandons[s.Opens]; previous != "" && previous != s.Abandon {
			return nil, &HostError{InvalidValue, "inconsistent scope abandonment Operations"}
		}
		abandons[s.Opens] = s.Abandon
	}
	return d, nil
}

func validScopeDecl(s ScopeDecl) bool {
	word := func(name string) bool {
		l, err := syntax.NewLexer(name)
		if err != nil {
			return false
		}
		t, err := l.Next(syntax.Operand)
		return err == nil && t.Kind == syntax.Word && t.Raw == name
	}
	if s.Closes != "" {
		return s.Opens == "" && s.Abandon == "" && word(s.Closes)
	}
	return word(s.Opens) && word(s.Abandon)
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
	for name := range g.operations {
		if scope := d.ops[name].Scope; scope != nil && scope.Opens != "" && !g.operations[scope.Abandon] {
			return nil, &HostError{InvalidValue, "Grant omits scope abandonment Operation"}
		}
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
	mu               sync.Mutex
	group            *Group
	scriptName       string
	runID            RunID
	grantName        string
	binding          any
	id               CallID
	segmentID        string
	now              time.Time
	context          context.Context
	starting         bool
	reached          bool
	charged          int64
	charge           func(int64) bool // valid only during this Host crossing
	scopeName        string
	automatic        bool
	invalidAutomatic bool
	failureDetail    string // validation diagnostic for automatic EffectFailure
}

func (c *Call) ID() CallID               { return c.id }
func (c *Call) ScriptName() string       { return c.scriptName }
func (c *Call) Group() *Group            { return c.group }
func (c *Call) RunID() RunID             { return c.runID }
func (c *Call) GrantName() string        { return c.grantName }
func (c *Call) SegmentID() string        { return c.segmentID }
func (c *Call) ScopeName() string        { return c.scopeName }
func (c *Call) Automatic() bool          { return c.automatic }
func (c *Call) Binding() any             { return c.binding }
func (c *Call) Now() time.Time           { return c.now }
func (c *Call) Context() context.Context { return c.context }
func (c *Call) Charge(fuel int64) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.starting {
		return &HostError{InvalidValue, "Charge must be a nonnegative safe integer while starting"}
	}
	if c.automatic {
		c.invalidAutomatic = true
		return &HostError{InvalidValue, "Charge is unavailable for automatic abandonment"}
	}
	if fuel < 0 || fuel > 9007199254740991 {
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
	c.refuseAutomaticSettlement()
	if fuel < 0 || fuel > 9007199254740991 {
		panic(&HostError{InvalidValue, "invalid late Fuel"})
	}
	c.queueSettlement("answer", v, nil, fuel)
}

// Fail queues a copied ScriptError; nil fails as host error.
func (c *Call) Fail(e *ScriptError) {
	c.refuseAutomaticSettlement()
	var copy *ScriptError
	if e != nil {
		clone := *e
		copy = &clone
	}
	c.queueSettlement("fail", Nothing, copy, 0)
}
func (c *Call) refuseAutomaticSettlement() {
	if c.automatic {
		c.mu.Lock()
		if c.starting {
			c.invalidAutomatic = true
		}
		c.mu.Unlock()
		panic(&HostError{InvalidValue, "automatic abandonment cannot settle"})
	}
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
