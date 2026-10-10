package machine

import (
	"fmt"
	"maps"
	"math"
	"math/big"
	"slices"

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
	Stopped // embedding Stop discards this Run without Script cleanup
)

type Limits struct {
	Bounded bool // embedding profiles specify Fuel, Alloc and Join, even at zero

	Fuel, Alloc, Persistent int64
	Depth, Pattern, Join    int
}

// Scope is the most recently opened surviving Host scope. The embedding owns
// slots; the machine uses this view to guard executed suspension boundaries.
type Scope struct{ Grant, Name string }

func (s *Scope) Error() value.Value {
	return ErrorValue("scope open", value.Pair{Key: "capability", Val: text(s.Grant)}, value.Pair{Key: "scope", Val: text(s.Name)})
}

type State struct {
	Stdlib                            bool
	Libraries                         map[string]*State
	Gone                              bool
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
	ID            int
	ControlID     int // continuation whose active scope identities are inherited
	OwnerID       int
	Recovery      bool
	Transfer      *RecoveryContext
	Code          *State
	Dispatch      *handlerDispatch
	ReceiverNames map[int]string // operand-stack tokens, not Script Values

	Body, PC      int
	Locals, Stack []value.Value
	Clause        bool
	Waiting       bool
	Accepted      bool
}
type Run struct {
	OpenScope     *Scope
	Rollback      []string
	WaitNS        *big.Int
	EventWait     *EventWait
	EventResume   *EventResume
	Join          *Join
	Abandons      []string
	FaultAbandons []string
	OperationWait bool
	SendWait      bool
	FunctionWait  bool
	SendResume    *SendResume
	// Expired is the duration of the Timeout Block whose deadline ended a
	// `wait` or `wait for`, raised when the Run resumes (ADR 0073).
	Expired        *value.Value
	ClockNS        *big.Int // Group Clock; nil for standalone execution
	PolicyDispatch bool     // a Delivery's entry clause, not a local Handler call
	Vetoed         bool
	Passed         bool
	VetoReason     value.Value

	CancellationOwners         []Frame
	Cancellation               []RecoveryCleanup
	Cancelling                 bool
	CleanupBudget, CleanupFuel int64
	CancelCode, CancelLimit    string

	Clause         int
	Clauses        []int
	Arguments      []value.Value
	Message        value.Value // the Fallback's message map, once a Delivery may reach one
	PersistentBase int64       // retained Script state outside variables and this Run

	Target        value.Value
	During        value.Value
	State         *State
	Frames        []Frame
	Recoveries    []*RecoveryContext
	FrameCounter  int
	OfferAttempt  int
	OfferRecords  []OfferRecord
	depth         int
	depthValid    bool
	depthRetained map[int]bool // real frames still owned by recovery or cancellation
	spareFrames   []Frame      // empty buffers reused only within ExecuteHosted
	trial         frameTrial   // undo state for the instruction ExecuteHosted is evaluating
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
	Unit    string
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
	return initializeLinked(unit, group, me, objects, nil)
}
func InitializeLinked(unit *lower.Unit, group any, libraries map[string]*State) (*State, error) {
	return initializeLinked(unit, group, value.Value{}, nil, libraries)
}
func InitializeLinkedBound(unit *lower.Unit, group any, libraries map[string]*State, me value.Value, objects map[string]value.Value) (*State, error) {
	return initializeLinked(unit, group, me, objects, libraries)
}
func initializeLinked(unit *lower.Unit, group any, me value.Value, objects map[string]value.Value, libraries map[string]*State) (*State, error) {
	s := &State{Libraries: libraries, Unit: unit, Group: group, Me: me, Variables: make([]value.Value, len(unit.Variables)), Definitions: make([]value.Value, len(unit.Definitions)), Objects: objects}
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
// A Delivery that may reach a Fallback Handler tries the Script's Fallback
// clauses, in every code unit, after the Selector's own, with the message map
// {name, args} as their one argument, built without charge (ADR 0064).
func StartDelivery(s *State, name string, args []value.Value, limits Limits, fallback bool) *Run {
	r := &Run{State: s, Limits: limits, Base: slices.Clone(s.Variables), Arguments: slices.Clone(args), PolicyDispatch: true}
	for _, b := range s.Unit.Bodies {
		if b.Checked.Kind == "handler" && b.Checked.Name == name && len(b.Checked.Node.Params) == len(args) {
			r.Clauses = append(r.Clauses, b.Index)
		}
	}
	if fallback {
		for _, b := range s.Unit.Bodies {
			if b.Checked.Kind == "fallback" {
				r.Clauses = append(r.Clauses, b.Index)
				r.Message, _ = value.NewMap([]value.Pair{{Key: "name", Val: text(name)}, {Key: "args", Val: value.NewList(slices.Clone(args))}})
			}
		}
	}
	r.nextClause()
	return r
}
func (r *Run) nextClause() {
	r.setFrames(nil)
	if len(r.Clauses) == 0 {
		r.Clause = 0
		r.Status = Unhandled
		return
	}
	body := r.Clauses[0]
	r.Clauses = r.Clauses[1:]
	b := r.State.Unit.Bodies[body]
	r.Clause = b.Clause
	args := r.Arguments
	if b.Checked.Kind == "fallback" {
		args = []value.Value{r.Message}
	}
	r.pushFrame(body, args)
}

// Fallback reports whether a body is a Fallback Handler clause (ADR 0064).
func Fallback(b *lower.Body) bool { return b.Checked.Kind == "fallback" }

func (r *Run) pushFrame(body int, args []value.Value) { r.pushCodeFrame(r.State, body, args) }
func (r *Run) pushCodeFrame(code *State, body int, args []value.Value) {
	b := code.Unit.Bodies[body]
	r.FrameCounter++
	f := Frame{ID: r.FrameCounter, Code: code, Body: body, Clause: b.Clause > 0}
	if n := len(r.spareFrames); n > 0 {
		spare := r.spareFrames[n-1]
		r.spareFrames[n-1] = Frame{}
		r.spareFrames = r.spareFrames[:n-1]
		f.Stack = spare.Stack[:0]
		f.Locals = spare.Locals[:0]
	}
	f.Locals = append(f.Locals, make([]value.Value, len(b.Checked.Locals))...)
	copy(f.Locals[1:], args)
	if b.Checked.During != "" {
		f.Locals[b.Checked.Slot(b.Checked.During)] = r.During
	}
	r.Frames = append(r.Frames, f)
	if r.depthValid {
		r.depth++ // every call receives a fresh real frame ID
	}
}

// SetDuring binds the failed message before dispatch, including Guards. Every
// later error clause or local call in this Run receives the same binding.
func (r *Run) SetDuring(v value.Value) {
	r.During = v
	for j := range r.Frames {
		f := &r.Frames[j]
		b := f.Code.Unit.Bodies[f.Body].Checked
		if b.During != "" {
			f.Locals[b.Slot(b.During)] = v
		}
	}
}
func (r *Run) fault(limit string) {
	r.invalidateDepth()
	r.Recoveries = nil
	r.Cancellation = nil
	r.CancellationOwners = nil
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
	if !r.Cancelling && (r.Limits.Fuel > 0 || r.Limits.Bounded) && fuel > r.Limits.Fuel-r.Fuel {
		r.fault("fuel")
		return false
	}
	if (r.Limits.Alloc > 0 || r.Limits.Bounded) && alloc > r.Limits.Alloc-r.Alloc {
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

// Receiver keeps Script-name tokens separate from Object Values. Up sends
// begin at the current owner's parent.
type Receiver struct {
	Name     string
	Object   value.Value
	Up       bool
	Function value.Value
}

// SendFunc commits a paid message and registers a reply when wait is true.
// A returned error is raised at the paid instruction.
type SendFunc func(to Receiver, message string, args []value.Value, wait bool) *value.Value

// ExecuteSelected notifies the scheduler when an entry clause's combined
// charge succeeds, before effects commit. Both callbacks belong to this turn;
// faults, preemption and cleanup cannot retain them in Run state.
func (r *Run) ExecuteSelected(slice int64, paid func(), send SendFunc) {
	r.ExecuteHosted(slice, paid, send, nil, nil)
}
func (r *Run) ExecuteHosted(slice int64, paid func(), send SendFunc, operation OperationFunc, property PropertyFunc, boundary ...func()) {
	if r.Status != Running && r.Status != Preempted {
		return
	}
	r.Status = Running
	defer func() { r.spareFrames, r.trial = nil, frameTrial{} }()
	start := r.Fuel
	for r.Status == Running {
		if len(boundary) > 0 {
			boundary[0]()
			if r.Status != Running {
				break
			}
		}
		f := &r.Frames[len(r.Frames)-1]
		b := f.Code.Unit.Bodies[f.Body]
		i := b.Code[f.PC]
		r.At = i
		r.PC = b.First + f.PC
		foreign := r.foreignWaitCall(f, i)
		if !Supported(i) || foreign && send == nil || r.unrepresentableWait(f, i) || sends(i.Name) && send == nil {
			r.Status = Blocked
			break
		}
		if r.PolicyDispatch && len(r.Frames) == 1 && !r.Cancelling && !f.Accepted && f.PC == b.DispatchEnd {
			r.Status = Dispatching
			break
		}
		prop := propertyRequest(f, i)
		if prop != nil && inGuard(f) {
			prop = nil // ordinary key evaluation raises wrong kind without a Host call
		}
		if prop != nil || i.Name == "ask" || i.Name == "tell" || i.Name == "ask-wait" || i.Name == "join-ask" {
			if i.Name == "join-ask" && (r.Limits.Join > 0 || r.Limits.Bounded) && len(r.Join.Members) >= r.Limits.Join {
				r.fault("join")
				break
			}
			if prop != nil && property == nil || prop == nil && operation == nil {
				r.Status = Blocked
				break
			}
			n := 0
			var args []value.Value
			if prop != nil {
				n = prop.pops
			} else {
				n = i.Operands()[2].Index
				args = slices.Clone(f.Stack[len(f.Stack)-n:])
			}
			wasCancelling := r.Cancelling
			pay := func(fuel, alloc int64) bool {
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
			}
			var result value.Value
			var err *value.Value
			blocked := false
			if prop != nil {
				result, err = property(prop.object, prop.name, prop.set, prop.input, pay)
			} else {
				result, err, blocked = operation(i.Operands()[0].Text, i.Operands()[1].Text, args, pay)
			}
			if len(boundary) > 0 {
				boundary[0]()
			}
			if r.Status == Stopped {
				break
			}
			if !wasCancelling && r.Cancelling {
				continue
			}
			if blocked {
				r.Status = Blocked
				break
			}
			if r.Status == Faulted || r.Status == Cancelled {
				break
			}
			if err != nil {
				if f.Clause && !pay(0, 0) {
					break
				}
				r.raise(*err)
			} else {
				f.Stack = f.Stack[:len(f.Stack)-n]
				if i.Name == "ask" || prop != nil && !prop.set {
					f.Stack = append(f.Stack, result)
				}
				f.PC++
				if i.Name == "ask-wait" {
					r.Status = Suspended
					r.checkRetainedState()
				}
			}
			if slice > 0 && r.Fuel-start >= slice && r.Status == Running {
				r.Status = Preempted
			}
			continue
		}
		if (i.Name == "join-send" || i.Name == "join-send-named" || i.Name == "join-send-spread") && (r.Limits.Join > 0 || r.Limits.Bounded) && len(r.Join.Members) >= r.Limits.Join {
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
		late := r.pastDeadline(f, i.Name)
		if len(r.Recoveries) > 0 {
			// Retained continuations can share the old operand buffer.
			// Keep their failed/control stack intact while active control advances.
			f.Stack = slices.Clone(f.Stack)
		}
		t := &r.trial
		t.begin(f)
		m, effect, err := r.evaluate(f, t, i)
		if (i.Name == "call-import" || i.Name == "call" || i.Name == "call-value" || i.Name == "call-handler" || i.Name == "call-value-wait" || i.Name == "call-handler-wait") && !foreign && err == nil && r.Limits.Depth > 0 && r.realDepth() >= r.Limits.Depth {
			t.restore(f)
			r.fault("depth")
			break
		}
		if i.Name == "make-pattern" && err == nil && r.Limits.Pattern > 0 && patternSize(m.Result.Text()) > r.Limits.Pattern {
			t.restore(f)
			r.fault("pattern")
			break
		}
		// A Suspension Point reached after its Timeout Block's deadline raises
		// at once, before `scope open`, and charges nothing (ADR 0073).
		if err == nil && late {
			t.restore(f)
			if f.Clause {
				if !r.pay(4, 0) {
					break
				}
				f.Clause = false
			}
			r.raise(*r.DeadlineError())
			if slice > 0 && r.Fuel-start >= slice && r.Status == Running {
				r.Status = Preempted
			}
			continue
		}
		if err == nil && r.OpenScope != nil && (i.Name == "wait" || i.Name == "wait-for" || i.Name == "wait-for-any" || i.Name == "join-start" || i.Name == "send-wait" || i.Name == "send-named-wait" || i.Name == "send-spread-wait" || i.Name == "send-up-wait" || foreign) {
			t.restore(f)
			if f.Clause {
				if !r.pay(4, 0) {
					break
				}
				f.Clause = false
			}
			r.raise(r.OpenScope.Error())
			if slice > 0 && r.Fuel-start >= slice && r.Status == Running {
				r.Status = Preempted
			}
			continue
		}
		fuel, alloc := ChargeRate(i.Rate, m)
		if f.Clause {
			fuel += 4
		}
		if !r.pay(fuel, alloc) {
			t.restore(f)
			break
		}
		if f.Clause && f.Accepted && len(r.Frames) == 1 && paid != nil {
			notify := paid
			paid = nil
			notify()
		}
		f.Clause = false
		// Sends read the operands the instruction popped.
		if err == nil && sends(i.Name) {
			top := len(t.stack) - 1
			recipient := Receiver{Up: i.Name == "send-up" || i.Name == "send-up-wait"}
			if !recipient.Up {
				recipient.Name = t.names[top]
				recipient.Object = t.operand(top)
			}
			var message string
			switch {
			case namedSend(i.Name):
				message = t.operand(top - len(m.Args) - 1).Text()
			case spreadSend(i.Name):
				message = t.operand(top - 2).Text()
			default:
				message = i.Operands()[0].Text
			}
			err = send(recipient, message, m.Args, i.Name != "send" && i.Name != "send-named" && i.Name != "send-spread" && i.Name != "send-up")
		}
		if err == nil && foreign {
			fn := t.operand(len(t.stack) - i.Operands()[0].Index - 1)
			err = send(Receiver{Function: fn}, "", m.Args, true)
		}

		if err != nil {
			popped := f.Stack
			t.restore(f)
			if i.Name == "throw" {
				// Raising retains this frame without the thrown value.
				f.Stack = popped
			}
			r.raise(*err)
			if slice > 0 && r.Fuel-start >= slice && r.Status == Running {
				r.Status = Preempted
			}
			continue
		}
		f.PC++
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

// A foreign wait uses a Group adapter; standalone execution leaves it untouched.
func (r *Run) foreignWaitCall(f *Frame, i lower.Instruction) bool {
	if i.Name != "call-value-wait" {
		return false
	}
	n := i.Operands()[0].Index
	fn := f.Stack[len(f.Stack)-n-1]
	if fn.Kind == value.Function {
		if home, ok := fn.Function().Owner.(*State); ok && home.Gone {
			return false
		}
	}
	return fn.Kind == value.Function && fn.Function().Owner != nil && fn.Function().Body >= 0 && fn.Function().Owner != r.State
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
		if (r.Limits.Fuel > 0 || r.Limits.Bounded) && 4 > r.Limits.Fuel-r.Fuel {
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
	r.setFrames(nil)
	r.Status = Dropped
}

func (r *Run) raise(err value.Value) {
	code := err.Get("code").Text()
	raised := Raised{Unit: r.CodeName(), Handler: enclosingHandler(r.CurrentCode().Unit.Bodies[r.Frames[len(r.Frames)-1].Body].Checked), Code: code, PC: r.PC, Instruction: r.At}
	// The first applicable unwind entry decides whether this is a Guard skip.
search:
	for frame := len(r.Frames) - 1; frame >= 0; frame-- {
		f := r.Frames[frame]
		place := f.PC
		if f.Waiting {
			place--
		}
		for _, u := range f.Code.Unit.Bodies[f.Body].UnwindEntries() {
			if place >= u.First && place <= u.Last && u.Kind != "offer" {
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
		r.Cancellation = nil
		r.CancellationOwners = nil
		r.setFrames(nil)
		r.Status = Cancelled
		return
	}
	r.unwind(r.positionedError(err))
}

func (r *Run) positionedError(err value.Value) value.Value {
	// Errors add their instruction position only when absent; map keys follow
	// the error catalogue's order.
	if !hasKey(err, "at") {
		f := r.Frames[len(r.Frames)-1]
		code, pos := f.Code, r.At.Pos
		if code.Stdlib {
			for j := len(r.Frames) - 2; j >= 0; j-- {
				caller := r.Frames[j]
				if !caller.Code.Stdlib {
					code, f = caller.Code, caller
					pos = code.Unit.Bodies[f.Body].Code[f.PC-1].Pos
					break
				}
			}
		}
		at, _ := value.NewMap([]value.Pair{{Key: "unit", Val: text(codeName(code, f.Body))}, {Key: "handler", Val: text(enclosingHandler(code.Unit.Bodies[f.Body].Checked))}, {Key: "line", Val: integer(int64(pos.Line))}, {Key: "column", Val: integer(int64(pos.Column))}})
		err = err.WithEntries(append(slices.Clone(err.Entries()), value.Pair{Key: "at", Val: at}))
	}
	return err
}
func (r *Run) unwindLegacy(err value.Value) {
	for frame := len(r.Frames) - 1; frame >= 0; frame-- {
		f := &r.Frames[frame]
		place := f.PC
		if f.Waiting {
			place--
		}
		for _, u := range f.Code.Unit.Bodies[f.Body].UnwindEntries() {
			if place < u.First || place > u.Last || u.Kind == "offer" || r.Cancelling && u.Kind != "finally" {
				continue
			}
			r.leaveJoin(frame, u.Target)
			err = r.replaceCleanupError(err, frame, u.First)
			if !r.Cancelling && !r.pay(int64(4*(len(r.Frames)-1-frame)), 0) {
				return
			}
			r.setFrames(r.Frames[:frame+1])
			f = &r.Frames[frame]
			f.Waiting = false
			f.Stack = slices.Clone(f.Stack[:u.Depth])
			f.ReceiverNames = maps.Clone(f.ReceiverNames) // retained frames may share the map
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
		r.setFrames(nil)
		r.Status = Cancelled
		return
	}
	r.AbandonJoin()
	err = r.replaceCleanupError(err, 0, -1)
	if !r.pay(int64(4*len(r.Frames)), 0) {
		return
	}
	r.setFrames(nil)
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
			err = err.WithEntries(append(slices.Clone(err.Entries()), value.Pair{Key: "during", Val: c.Error}))
		}
	}
	return err
}

func hasKey(v value.Value, key string) bool {
	_, found := v.MapEntry(key)
	return found
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
		r.Expired = nil
	}
	r.AbandonJoin()
	r.State.Variables = slices.Clone(r.Base)
	r.Base = slices.Clone(r.Base)
	r.Cancellation = r.cancellationScopes()
	for j := range r.Cancellation {
		r.Cancellation[j].Frame.Transfer = nil
	}
	owners := map[int]Frame{}
	for _, c := range r.Recoveries {
		for _, f := range c.Retained {
			if !f.Recovery {
				owners[f.ID] = f
			}
		}
	}
	for _, f := range r.Frames {
		if !f.Recovery {
			owners[f.ID] = f
		}
	}
	needed := map[int]bool{}
	for _, scope := range r.Cancellation {
		id := scope.Frame.ID
		if scope.Frame.OwnerID != 0 {
			id = scope.Frame.OwnerID
		}
		needed[id] = true
	}
	for _, scope := range r.Cancellation {
		id := scope.Frame.ID
		if scope.Frame.OwnerID != 0 {
			id = scope.Frame.OwnerID
		}
		if needed[id] {
			owner := owners[id]
			owner.Stack = nil
			owner.Transfer = nil
			r.CancellationOwners = append(r.CancellationOwners, owner)
			delete(needed, id)
		}
	}
	r.Recoveries = nil
	r.Cleanup = nil
	r.Cancelling = true
	r.CleanupBudget = budget
	r.Status = Running
	r.nextCancellationCleanup()
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
	frames := map[int]Frame{}
	for _, f := range r.CancellationOwners {
		frames[f.ID] = f
	}
	for _, scope := range r.Cancellation {
		if previous, ok := frames[scope.Frame.ID]; !ok || len(previous.Stack) < len(scope.Frame.Stack) {
			frames[scope.Frame.ID] = scope.Frame
		}
	}
	for _, c := range r.Recoveries {
		for _, f := range c.Retained {
			frames[f.ID] = f
			// Cleanup reuses the real frame's identity and locals, but its
			// operand stack does not replace the retained failure's operands.
			for _, active := range r.Frames {
				if active.ID == f.ID && active.Transfer == c {
					for j, v := range f.Stack {
						if f.ReceiverNames[j] == "" {
							size = saturatingAdd(size, Size(v))
						}
					}
					break
				}
			}
		}
		if c.Activation != nil {
			frames[c.Activation.ID] = *c.Activation
		}
		n := saturatingAdd(96, Size(c.Error))
		if c.Pending != nil && c.Pending.Kind == "offer" {
			n = saturatingAdd(n, int64(8*len(c.Pending.Args)))
			for _, v := range c.Pending.Args {
				n = saturatingAdd(n, Size(v))
			}
		}
		size = saturatingAdd(size, n)
	}
	for _, f := range r.Frames {
		frames[f.ID] = f
	}
	for _, f := range frames {
		n := int64(48)
		if !f.Recovery {
			n = int64(64 + 8*len(f.Locals))
			for _, v := range f.Locals {
				n = saturatingAdd(n, Size(v))
			}
		}
		for j, v := range f.Stack {
			if f.ReceiverNames[j] == "" {
				n = saturatingAdd(n, Size(v))
			}
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
	r.popFrame()
	if len(d.Bodies) > 0 {
		body := d.Bodies[0]
		d.Bodies = d.Bodies[1:]
		r.pushCodeFrame(f.Code, body, d.Args)
		r.Frames[len(r.Frames)-1].Dispatch = d
		return
	}
	caller := &r.Frames[len(r.Frames)-1]
	b := caller.Code.Unit.Bodies[caller.Body]
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
		entry := f.Code.Unit.Events[i.Operands()[0].Index]
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

// CurrentCode identifies the executing code unit independently of the Home Script.
func (r *Run) CurrentCode() *State {
	if len(r.Frames) == 0 {
		return r.State
	}
	return r.Frames[len(r.Frames)-1].Code
}

// sends reports whether an instruction puts a message in a mailbox.
func sends(name string) bool {
	switch name {
	case "send", "send-wait", "join-send", "send-up", "send-up-wait":
		return true
	}
	return namedSend(name) || spreadSend(name)
}

// namedSend reports whether a send pops a computed message name (ADR 0057).
func namedSend(name string) bool {
	return name == "send-named" || name == "send-named-wait" || name == "join-send-named"
}

// spreadSend reports whether a send pops its name, its arguments as one list
// and its receiver (ADR 0064).
func spreadSend(name string) bool {
	return name == "send-spread" || name == "send-spread-wait" || name == "join-send-spread"
}
