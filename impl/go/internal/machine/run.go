package machine

import (
	"fmt"
	"maps"
	"math"
	"math/big"
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
	Suspended
	Dispatching
	Parked
	Dropped
)

type Limits struct {
	Fuel, Alloc, Persistent int64
	Depth, Pattern, Join    int
}
type State struct {
	Group                             any
	Me                                value.Value
	Unit                              *lower.Unit
	Constants, Variables, Definitions []value.Value
	Objects                           map[string]value.Value
	ScriptNames                       []string // receiver Names are not Values
}
type handlerDispatch struct {
	Bodies []int
	Args   []value.Value
}
type Frame struct {
	Dispatch      *handlerDispatch
	ReceiverNames map[int]string // operand-stack tokens, not Script Values

	Body, PC      int
	Locals, Stack []value.Value
	Clause        bool
	Waiting       bool
	Accepted      bool
}
type Run struct {
	Rollback       []string
	WaitNS         *big.Int
	EventWait      *EventWait
	EventResume    *EventResume
	Join           *Join
	Abandons       []string
	FaultAbandons  []string
	SendWait       bool
	SendResume     *SendResume
	ClockNS        *big.Int // Group Clock; nil for standalone execution
	PolicyDispatch bool     // a Delivery's entry clause, not a local Handler call
	Vetoed         bool
	Passed         bool
	VetoReason     value.Value

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
	r := &Run{State: s, Limits: limits, Base: slices.Clone(s.Variables), Arguments: slices.Clone(args), PolicyDispatch: true}
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
	before := len(r.Abandons)
	r.AbandonJoin()
	r.FaultAbandons = append(r.FaultAbandons, r.Abandons[before:]...)
	r.Abandons = r.Abandons[:before]
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
	r.ExecuteSelected(slice, nil, nil)
}

// SendFunc commits a paid Script message, registering a reply when wait is true.
// False means mailbox full.
type SendFunc func(to, message string, args []value.Value, wait bool) bool

// ExecuteSelected notifies the scheduler when an entry clause's combined
// charge succeeds, before effects commit. Both callbacks belong to this turn;
// faults, preemption and cleanup cannot retain them in Run state.
func (r *Run) ExecuteSelected(slice int64, paid func(), send SendFunc) {
	r.ExecuteHosted(slice, paid, send, nil)
}
func (r *Run) ExecuteHosted(slice int64, paid func(), send SendFunc, operation OperationFunc) {
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
		if !Supported(i) || r.foreignWaitCall(f, i) || r.unrepresentableWait(f, i) || (i.Name == "send" || i.Name == "send-wait" || i.Name == "join-send") && (send == nil || f.Stack[len(f.Stack)-1].Kind == value.Object) {
			r.Status = Blocked
			break
		}
		if r.PolicyDispatch && len(r.Frames) == 1 && !r.Cancelling && !f.Accepted && f.PC == b.DispatchEnd {
			r.Status = Dispatching
			break
		}
		if i.Name == "ask" || i.Name == "tell" {
			if operation == nil {
				r.Status = Blocked
				break
			}
			n := i.Operands()[2].Index
			args := slices.Clone(f.Stack[len(f.Stack)-n:])
			result, err, blocked := operation(i.Operands()[0].Text, i.Operands()[1].Text, args, func(fuel, alloc int64) bool {
				if f.Clause {
					fuel += 4
				}
				if !r.pay(fuel, alloc) {
					return false
				}
				f.Clause = false
				if f.Accepted && len(r.Frames) == 1 && paid != nil {
					notify := paid
					paid = nil
					notify()
				}
				return true
			})
			if blocked {
				r.Status = Blocked
				break
			}
			if r.Status == Faulted || r.Status == Cancelled {
				break
			}
			if err != nil {
				r.raise(*err)
			} else {
				f.Stack = f.Stack[:len(f.Stack)-n]
				if i.Name == "ask" {
					f.Stack = append(f.Stack, result)
				}
				f.PC++
			}
			if slice > 0 && r.Fuel-start >= slice && r.Status == Running {
				r.Status = Preempted
			}
			continue
		}
		if i.Name == "join-send" && r.Limits.Join > 0 && len(r.Join.Members) >= r.Limits.Join {
			r.fault("join")
			break
		}
		if !r.preflight(f, i) {
			break
		}

		if (i.Name == "return" || i.Name == "veto" || i.Name == "pass") && len(r.Frames) == 1 && r.Limits.Persistent > 0 && r.persistentSize() > r.Limits.Persistent {
			r.fault("persistent")
			break
		}
		// Evaluate against a detached operand stack. State changes commit only
		// after the complete instruction charge has been accepted.
		trial := *f
		trial.Stack = slices.Clone(f.Stack)
		trial.Locals = slices.Clone(f.Locals)
		trial.ReceiverNames = maps.Clone(f.ReceiverNames)
		m, effect, err := r.evaluate(&trial, i)
		if (i.Name == "call" || i.Name == "call-value" || i.Name == "call-handler" || i.Name == "call-value-wait" || i.Name == "call-handler-wait") && err == nil && r.Limits.Depth > 0 && len(r.Frames) >= r.Limits.Depth {
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
		if f.Clause && f.Accepted && len(r.Frames) == 1 && paid != nil {
			notify := paid
			paid = nil
			notify()
		}
		f.Clause = false
		trial.Clause = false
		if err == nil && (i.Name == "send" || i.Name == "send-wait" || i.Name == "join-send") && !send(f.ReceiverNames[len(f.Stack)-1], i.Operands()[0].Text, m.Args, i.Name != "send") {
			v := failure("mailbox full", value.Pair{Key: "to", Val: text(f.ReceiverNames[len(f.Stack)-1])})
			err = &v
		}
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
		// A wait commits its instruction charge, but retaining its frames can
		// still fault the Segment before the scheduler installs a timer.
		if r.Status == Suspended {
			r.checkRetainedState()
		}
		if slice > 0 && r.Fuel-start >= slice && r.Status == Running {
			r.Status = Preempted
		}
	}
}

// Foreign Function Value calls await the cross-Script reply implementation.
// Keep their operands and charge untouched at that boundary.
func (r *Run) foreignWaitCall(f *Frame, i lower.Instruction) bool {
	if i.Name != "call-value-wait" {
		return false
	}
	n := i.Operands()[0].Index
	fn := f.Stack[len(f.Stack)-n-1]
	return fn.Kind == value.Function && fn.Function.Owner != nil && fn.Function.Body >= 0 && fn.Function.Owner != r.State
}

// Resume begins a new Segment at the Script state present when its turn starts.
// Run budgets and frames survive, while rollback starts from this new snapshot.
func (r *Run) Resume() {
	if r.Status != Suspended && r.Status != Parked && !(r.Cancelling && r.Status == Running) {
		return
	}
	r.Base = slices.Clone(r.State.Variables)
	r.WaitNS = nil
	if r.EventResume != nil {
		r.resumeEvent()
	}
	r.Status = Running
}

// AcceptClause checks the unpaid dispatch rate before applying a policy.
// Parking and dropping pay it alone; otherwise the first body instruction
// pays it together with its own charge. Guards may already have paid it.
func (r *Run) AcceptClause(dispatchOnly bool) bool {
	f := &r.Frames[0]
	if f.Clause {
		if r.Limits.Fuel > 0 && 4 > r.Limits.Fuel-r.Fuel {
			r.fault("fuel")
			return false
		}
		if dispatchOnly {
			if !r.pay(4, 0) {
				return false
			}
			f.Clause = false
		}
	}
	f.Accepted = true
	r.Status = Running
	return true
}

func (r *Run) persistentSize() int64 {
	size := r.PersistentBase
	for _, v := range r.State.Variables {
		size = saturatingAdd(size, Size(v))
	}
	return size
}
func (r *Run) checkRetainedState() {
	if r.Limits.Persistent > 0 && saturatingAdd(r.persistentSize(), r.RetainedSize()) > r.Limits.Persistent {
		r.fault("persistent")
	}
}
func (r *Run) Park() {
	r.Status = Parked
	r.checkRetainedState()
}
func (r *Run) Drop() {
	if r.Limits.Persistent > 0 && r.persistentSize() > r.Limits.Persistent {
		r.fault("persistent")
		return
	}
	r.Frames = nil
	r.Status = Dropped
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
	r.unwind(r.positionedError(err))
}

func (r *Run) positionedError(err value.Value) value.Value {
	// Errors add their instruction position only when absent; map keys follow
	// the error catalogue's order.
	if !hasKey(err, "at") {
		at, _ := value.NewMap([]value.Pair{{Key: "unit", Val: text(r.State.Unit.Name)}, {Key: "handler", Val: text(r.State.Unit.Bodies[r.Frames[len(r.Frames)-1].Body].Checked.Name)}, {Key: "line", Val: integer(int64(r.At.Pos.Line))}, {Key: "column", Val: integer(int64(r.At.Pos.Column))}})
		err.Entries = append(slices.Clone(err.Entries), value.Pair{Key: "at", Val: at})
	}
	return err
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
			r.leaveJoin(frame, u.Target)
			err = r.replaceCleanupError(err, frame, u.First)
			if !r.Cancelling && !r.pay(int64(4*(len(r.Frames)-1-frame)), 0) {
				return
			}
			r.Frames = r.Frames[:frame+1]
			f = &r.Frames[frame]
			f.Waiting = false
			f.Stack = slices.Clone(f.Stack[:u.Depth])
			for slot := range f.ReceiverNames {
				if slot >= len(f.Stack) {
					delete(f.ReceiverNames, slot)
				}
			}
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
	r.AbandonJoin()
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
	if r.Cancelling || r.Status == Completed || r.Status == Errored || r.Status == Faulted || r.Status == Cancelled || r.Status == Unhandled || r.Status == Dropped {
		return
	}
	if r.Status == Suspended || r.Status == Parked {
		// Between Segments, earlier writes are committed. The unwind table
		// applies at the next parked instruction, or the wait that advanced PC.
		r.Base = slices.Clone(r.State.Variables)
		if r.Status == Suspended {
			r.Frames[len(r.Frames)-1].PC--
		}
		r.WaitNS = nil
		r.EventWait = nil
		r.EventResume = nil
		r.SendWait = false
		r.SendResume = nil
	}
	r.AbandonJoin()
	r.State.Variables = slices.Clone(r.Base)
	r.Base = slices.Clone(r.Base)
	r.Cancelling = true
	r.CleanupBudget = budget
	r.Status = Running
	r.unwind(value.Value{})
}
func (r *Run) RetainedSize() int64 {
	size := int64(96)
	if r.SendWait {
		size = saturatingAdd(size, 48)
	}
	if p := r.SendResume; p != nil {
		size = saturatingAdd(size, sendResumeSize(*p))
	}
	if j := r.Join; j != nil {
		if j.Ready && j.Failure != nil {
			size = saturatingAdd(size, sendResumeSize(*j.Failure))
		} else {
			for _, m := range j.Members {
				if m.Reply == nil {
					size = saturatingAdd(size, 48)
				} else {
					size = saturatingAdd(size, sendResumeSize(*m.Reply))
				}
			}
		}
	}
	if r.EventWait != nil {
		for _, v := range r.EventWait.Values {
			size = saturatingAdd(size, Size(v))
		}
	}
	if p := r.EventResume; p != nil && !p.Timeout {
		size = saturatingAdd(size, Size(p.Message))
		for _, v := range p.Bindings {
			size = saturatingAdd(size, Size(v))
		}
	}
	for _, f := range r.Frames {
		n := int64(64 + 8*len(f.Locals))
		for _, v := range f.Locals {
			n = saturatingAdd(n, Size(v))
		}
		for j, v := range f.Stack {
			if f.ReceiverNames[j] != "" {
				continue
			}
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

// The embedding API uses time.Time for deadlines. Defer waits beyond its
// representable range, without wrapping the timer or charging the instruction.
func (r *Run) unrepresentableWait(f *Frame, i lower.Instruction) bool {
	if r.ClockNS == nil {
		return false
	}
	var deadline *big.Int
	switch i.Name {
	case "wait":
		ns, err := waitNanos(f.Stack[len(f.Stack)-1])
		if err != nil {
			return false
		}
		deadline = new(big.Int).Add(r.ClockNS, ns)
	case "wait-for", "wait-for-any":
		entry := r.State.Unit.Events[i.Operands()[0].Index]
		w, err := r.eventWait(i.Name, entry, f.Stack[len(f.Stack)-eventValueCount(entry):])
		if err != nil || w.Deadline == nil {
			return false
		}
		deadline = w.Deadline
	default:
		return false
	}
	seconds := new(big.Int).Div(deadline, big.NewInt(1e9))
	// Go's signed seconds count starts at year 0001, 62135596800 seconds
	// before the Unix epoch. Its upper bound must leave room for that offset.
	return !seconds.IsInt64() || seconds.Cmp(big.NewInt(math.MaxInt64-62135596800)) > 0
}
