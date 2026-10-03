package machine

import (
	"fmt"
	"slices"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

type Status int

const (
	Running Status = iota
	Preempted
	Completed
	Errored
	Faulted
	Blocked
	Unhandled
	Cancelled
)

type Limits struct {
	Fuel, Alloc, Persistent int64
	Depth, Pattern          int
}
type State struct {
	Group                             any
	Me                                value.Value
	Unit                              *lower.Unit
	Constants, Variables, Definitions []value.Value
	Objects                           map[string]value.Value
}
type handlerDispatch struct {
	Bodies []int
	Args   []value.Value
}
type Frame struct {
	Dispatch *handlerDispatch

	Body, PC      int
	Locals, Stack []value.Value
	Clause        bool
	Waiting       bool
}
type Run struct {
	Rollback []string

	Cancelling                 bool
	CleanupBudget, CleanupFuel int64
	CancelCode, CancelLimit    string

	Clause         int
	Clauses        []int
	Arguments      []value.Value
	PersistentBase int64 // retained Script state outside variables and this Run

	Target        value.Value
	During        value.Value
	State         *State
	Frames        []Frame
	Base          []value.Value
	Limits        Limits
	Status        Status
	Result, Error value.Value
	Limit         string
	Fuel, Alloc   int64
	At            lower.Instruction
	PC            int
	Initializing  bool
	Raises        []Raised
	Cleanup       []Cleanup
}
type Cleanup struct {
	Frame int
	Error value.Value
	Entry int
}
type Raised struct {
	Handler string

	Guard bool
	Value *value.Value

	Code        string
	PC          int
	Instruction lower.Instruction
}
type InitError struct{ Instruction lower.Instruction }

func (e *InitError) Error() string {
	return fmt.Sprintf("initialiser failed at %d:%d", e.Instruction.Pos.Line, e.Instruction.Pos.Column)
}
func Initialize(unit *lower.Unit) (*State, error) {
	return InitializeBound(unit, nil, value.Value{}, nil)
}

// InitializeBound establishes home identity and Host bindings before evaluating
// initializers, including captured Function Values. Initializers are uncharged.
func InitializeBound(unit *lower.Unit, group any, me value.Value, objects map[string]value.Value) (*State, error) {
	s := &State{Unit: unit, Group: group, Me: me, Variables: make([]value.Value, len(unit.Variables)), Definitions: make([]value.Value, len(unit.Definitions)), Objects: objects}
	if s.Objects == nil {
		s.Objects = map[string]value.Value{}
	}
	for _, text := range unit.Constants {
		v, e := constant(text)
		if e != nil {
			return nil, e
		}
		s.Constants = append(s.Constants, v)
	}
	r := Start(s, 0, nil, Limits{})
	r.Initializing = true
	r.Execute(0)
	if r.Status != Completed {
		return nil, &InitError{r.At}
	}
	return s, nil
}
func Start(s *State, body int, args []value.Value, limits Limits) *Run {
	r := &Run{State: s, Limits: limits, Base: slices.Clone(s.Variables)}
	r.pushFrame(body, args)
	return r
}

// StartDelivery retains dispatch state across preemption and clause failure.
func StartDelivery(s *State, name string, args []value.Value, limits Limits) *Run {
	r := &Run{State: s, Limits: limits, Base: slices.Clone(s.Variables), Arguments: slices.Clone(args)}
	for _, b := range s.Unit.Bodies {
		if b.Checked.Kind == "handler" && b.Checked.Name == name && len(b.Checked.Node.Params) == len(args) {
			r.Clauses = append(r.Clauses, b.Index)
		}
	}
	r.nextClause()
	return r
}
func (r *Run) nextClause() {
	r.Frames = nil
	if len(r.Clauses) == 0 {
		r.Clause = 0
		r.Status = Unhandled
		return
	}
	body := r.Clauses[0]
	r.Clauses = r.Clauses[1:]
	r.Clause = r.State.Unit.Bodies[body].Clause
	r.pushFrame(body, r.Arguments)
}

func (r *Run) pushFrame(body int, args []value.Value) {
	b := r.State.Unit.Bodies[body]
	f := Frame{Body: body, Locals: make([]value.Value, len(b.Checked.Locals)), Clause: b.Clause > 0}
	copy(f.Locals[1:], args)
	if b.Checked.During != "" {
		f.Locals[b.Checked.Slot(b.Checked.During)] = r.During
	}
	r.Frames = append(r.Frames, f)
}

// SetDuring binds the failed message before dispatch, including Guards. Every
// later error clause or local call in this Run receives the same binding.
func (r *Run) SetDuring(v value.Value) {
	r.During = v
	for j := range r.Frames {
		f := &r.Frames[j]
		b := r.State.Unit.Bodies[f.Body].Checked
		if b.During != "" {
			f.Locals[b.Slot(b.During)] = v
		}
	}
}
func (r *Run) fault(limit string) {
	if r.Cancelling {
		r.Status = Cancelled
		r.CancelLimit = limit
		if limit == "fuel" {
			r.CancelLimit = "cleanup"
		}
	} else {
		r.Status = Faulted
	}
	r.Limit = limit
	for j, v := range r.State.Variables {
		if v.Display() != r.Base[j].Display() {
			r.Rollback = append(r.Rollback, r.State.Unit.Variables[j])
		}
	}
	r.State.Variables = slices.Clone(r.Base)
}
func (r *Run) pay(fuel, alloc int64) bool {
	if r.Initializing {
		return true
	}
	if r.Cancelling && fuel > r.CleanupBudget-r.CleanupFuel {
		r.fault("fuel")
		return false
	}
	if !r.Cancelling && r.Limits.Fuel > 0 && fuel > r.Limits.Fuel-r.Fuel {
		r.fault("fuel")
		return false
	}
	if r.Limits.Alloc > 0 && alloc > r.Limits.Alloc-r.Alloc {
		r.fault("alloc")
		return false
	}
	if r.Cancelling {
		r.CleanupFuel += fuel
	}
	r.Fuel += fuel
	r.Alloc += alloc
	return true
}
func (r *Run) Execute(slice int64) {
	if r.Status != Running && r.Status != Preempted {
		return
	}
	r.Status = Running
	start := r.Fuel
	for r.Status == Running {
		f := &r.Frames[len(r.Frames)-1]
		b := r.State.Unit.Bodies[f.Body]
		i := b.Code[f.PC]
		r.At = i
		r.PC = b.First + f.PC
		if !Supported(i) {
			r.Status = Blocked
			break
		}
		if !r.preflight(f, i) {
			break
		}

		if i.Name == "return" && len(r.Frames) == 1 && r.Limits.Persistent > 0 {
			size := r.PersistentBase
			for _, v := range r.State.Variables {
				size += Size(v)
			}
			if size > r.Limits.Persistent {
				r.fault("persistent")
				break
			}
		}
		// Evaluate against a detached operand stack. State changes commit only
		// after the complete instruction charge has been accepted.
		trial := *f
		trial.Stack = slices.Clone(f.Stack)
		trial.Locals = slices.Clone(f.Locals)
		m, effect, err := r.evaluate(&trial, i)
		if (i.Name == "call" || i.Name == "call-value" || i.Name == "call-handler") && err == nil && r.Limits.Depth > 0 && len(r.Frames) >= r.Limits.Depth {
			r.fault("depth")
			break
		}
		if i.Name == "make-pattern" && err == nil && r.Limits.Pattern > 0 && patternSize(m.Result.Text) > r.Limits.Pattern {
			r.fault("pattern")
			break
		}
		key := ""
		for _, entry := range generated.Machine.Instruction {
			if entry.Name == i.Name {
				key = entry.Cost
				break
			}
		}
		if i.Name == "call-builtin" {
			key = "builtin." + i.Operands()[0].Text
		}
		fuel, alloc := Charge(key, m)
		if f.Clause {
			fuel += 4
		}
		if !r.pay(fuel, alloc) {
			break
		}
		f.Clause = false
		trial.Clause = false
		if err != nil {
			r.raise(*err)
			if slice > 0 && r.Fuel-start >= slice && r.Status == Running {
				r.Status = Preempted
			}
			continue
		}
		trial.PC++
		*f = trial
		if effect != nil {
			effect()
		}
		if slice > 0 && r.Fuel-start >= slice && r.Status == Running {
			r.Status = Preempted
		}
	}
}
func (r *Run) raise(err value.Value) {
	code := err.Get("code").Text
	raised := Raised{Handler: r.State.Unit.Bodies[r.Frames[len(r.Frames)-1].Body].Checked.Name, Code: code, PC: r.PC, Instruction: r.At}
	// The first applicable unwind entry decides whether this is a Guard skip.
search:
	for frame := len(r.Frames) - 1; frame >= 0; frame-- {
		f := r.Frames[frame]
		place := f.PC
		if f.Waiting {
			place--
		}
		for _, u := range r.State.Unit.Bodies[f.Body].UnwindEntries() {
			if place >= u.First && place <= u.Last {
				raised.Guard = u.Kind == "guard"
				if raised.Guard && frame == len(r.Frames)-1 && (r.At.Name == "branch-false" || r.At.Name == "branch-true") && code == "wrong kind" {
					v := f.Stack[len(f.Stack)-1]
					raised.Value = &v
					raised.Code = ""
				}
				break search
			}
		}
	}
	r.Raises = append(r.Raises, raised)
	if r.Cancelling {
		r.CancelCode = code
		r.Frames = nil
		r.Status = Cancelled
		return
	}
	// Errors add their instruction position only when absent; map keys follow
	// the error catalogue's order.
	if !hasKey(err, "at") {
		at, _ := value.NewMap([]value.Pair{{Key: "unit", Val: text(r.State.Unit.Name)}, {Key: "handler", Val: text(r.State.Unit.Bodies[r.Frames[len(r.Frames)-1].Body].Checked.Name)}, {Key: "line", Val: integer(int64(r.At.Pos.Line))}, {Key: "column", Val: integer(int64(r.At.Pos.Column))}})
		err.Entries = append(slices.Clone(err.Entries), value.Pair{Key: "at", Val: at})
	}
	r.unwind(err)
}
func (r *Run) unwind(err value.Value) {
	for frame := len(r.Frames) - 1; frame >= 0; frame-- {
		f := &r.Frames[frame]
		place := f.PC
		if f.Waiting {
			place--
		}
		for _, u := range r.State.Unit.Bodies[f.Body].UnwindEntries() {
			if place < u.First || place > u.Last || r.Cancelling && u.Kind != "finally" {
				continue
			}
			err = r.replaceCleanupError(err, frame, u.First)
			if !r.Cancelling && !r.pay(int64(4*(len(r.Frames)-1-frame)), 0) {
				return
			}
			r.Frames = r.Frames[:frame+1]
			f = &r.Frames[frame]
			f.Waiting = false
			f.Stack = slices.Clone(f.Stack[:u.Depth])
			f.PC = u.Target
			switch u.Kind {
			case "catch":
				f.Stack = append(f.Stack, err)
			case "guard":
			case "finally":
				r.Cleanup = append(r.Cleanup, Cleanup{Frame: frame, Error: err, Entry: u.Target})
			}
			return
		}
	}
	if r.Cancelling {
		r.Frames = nil
		r.Status = Cancelled
		return
	}
	err = r.replaceCleanupError(err, 0, -1)
	if !r.pay(int64(4*len(r.Frames)), 0) {
		return
	}
	r.Frames = nil
	r.Error = err
	r.Status = Errored
}

func (r *Run) replaceCleanupError(err value.Value, frame, entry int) value.Value {
	for len(r.Cleanup) > 0 {
		c := r.Cleanup[len(r.Cleanup)-1]
		if c.Frame < frame || c.Frame == frame && entry >= c.Entry {
			break
		}
		r.Cleanup = r.Cleanup[:len(r.Cleanup)-1]
		if !hasKey(err, "during") {
			err.Entries = append(slices.Clone(err.Entries), value.Pair{Key: "during", Val: c.Error})
		}
	}
	return err
}

func hasKey(v value.Value, key string) bool {
	for _, p := range v.Entries {
		if p.Key == key {
			return true
		}
	}
	return false
}

// Cancel rolls back the interrupted Segment, then enters the nearest finally
// without an error or unwind charge. Cleanup has its own Fuel budget.
func (r *Run) Cancel(budget int64) {
	if r.Status == Completed || r.Status == Errored || r.Status == Faulted || r.Status == Cancelled || r.Status == Unhandled {
		return
	}
	r.State.Variables = slices.Clone(r.Base)
	r.Base = slices.Clone(r.Base)
	r.Cancelling = true
	r.CleanupBudget = budget
	r.Status = Running
	r.unwind(value.Value{})
}
func (r *Run) RetainedSize() int64 {
	size := int64(96)
	for _, f := range r.Frames {
		n := int64(64 + 8*len(f.Locals))
		for _, v := range f.Locals {
			n = saturatingAdd(n, Size(v))
		}
		for _, v := range f.Stack {
			n = saturatingAdd(n, Size(v))
		}
		size = saturatingAdd(size, n)
	}
	return size
}

func (r *Run) failClause() {
	f := r.Frames[len(r.Frames)-1]
	if f.Dispatch == nil {
		r.nextClause()
		return
	}
	d := f.Dispatch
	r.Frames = r.Frames[:len(r.Frames)-1]
	if len(d.Bodies) > 0 {
		body := d.Bodies[0]
		d.Bodies = d.Bodies[1:]
		r.pushFrame(body, d.Args)
		r.Frames[len(r.Frames)-1].Dispatch = d
		return
	}
	caller := &r.Frames[len(r.Frames)-1]
	b := r.State.Unit.Bodies[caller.Body]
	r.At = b.Code[caller.PC-1]
	r.PC = b.First + caller.PC - 1
	r.raise(failure("no match"))
}
