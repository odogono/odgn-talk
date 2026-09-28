// PROTOTYPE: proposed Go Core embedding API (throwaway). Nothing here compiles
// against a real Core; bodies are elided. The Example Hosts in ../0N-* are
// written against these signatures. `// ??` marks a place the API strains.
//
// Shape in one breath:
//   Core ── NewGroup ──> Group ── Load ──> Script
//   Host defines Capabilities (Operations with shape, cost, mode) and Object
//   Kinds once; grants a subset per Script at Load; delivers messages; pumps
//   the Group; receives Reports; saves and restores whole Groups.
package talk

import (
	"context"
	"time"
)

// ---------------------------------------------------------------------------
// Versions (ADR 0009): lockstep Hosts compare these before exchanging anything.
// ---------------------------------------------------------------------------

type Versions struct {
	Language   string // "1.0"
	CostModel  string // "1"  (versioned together with the Abstract Machine, ADR 0010)
	Machine    string // "1"
	Unicode    string // "16.0" (pinned by Language, ADR 0011; reported for diagnostics)
	Core       string // "go/0.1.0" — informational, never compared for parity
	SaveFormat string // "go-1" — same-core only (ADR 0008)
}

func CoreVersions() Versions

// ParityCompatible is true when two Cores promise bit-for-bit parity:
// equal Language, CostModel and Machine. SaveFormat and Core are ignored.
func ParityCompatible(a, b Versions) bool

// ---------------------------------------------------------------------------
// Values crossing the boundary (ADR 0001: snapshotted out, converted in).
// ---------------------------------------------------------------------------

// Value is an immutable Script value or a Host Object handle. Hosts build
// values with the constructors below; there is no reflection-based
// "convert any Go value" helper, because every conversion rule is spec text.
type Value struct{ /* opaque */ }

func Nothing() Value
func Bool(b bool) Value
func Text(s string) (Value, error) // invalid UTF-8 is an error; NFC applied here ?? charged to whom
func MustText(s string) Value       // for literals in Host code
func Int(i int64) Value             // exact
func Dec(s string) (Value, error)   // "12.50", canonical decimal literal only (ADR 0002)
func FromFloat(f float64) Value     // shortest round-trip decimal; NaN/Inf panic ?? or error
func Quantity(n Value, unit string) (Value, error)
func Bytes(b []byte) Value // copied in (ADR 0013 consequence)
func List(vs ...Value) Value

// Maps keep insertion order (ADR 0009), so a Go map[string]Value cannot be
// the input: its iteration order is random. Build maps from pairs.
func Map(pairs ...Pair) Value

type Pair struct {
	Key string
	Val Value
}

func KV(k string, v Value) Pair

// Reading values out. Each accessor copies (Bytes) or returns immutable data.
func (v Value) Kind() Kind
func (v Value) AsText() (string, bool)
func (v Value) AsDec() (Decimal, bool) // Decimal: the Core's own type, with Int64(), String(), Float64Lossy()
func (v Value) AsBytes() ([]byte, bool)
func (v Value) Get(key string) Value   // Nothing when missing or not a map
func (v Value) Index(i int) Value      // 1-based, Nothing past end
func (v Value) Len() int
func (v Value) Entries() []Pair        // in insertion order
func (v Value) Object() (*Object, bool)
func (v Value) String() string // canonical text form (the same form `&` produces)

type Kind int
type Decimal struct{ /* Core-owned decimal128-style value */ }

// ---------------------------------------------------------------------------
// Shapes: argument and result shapes for Operations and Host messages.
// The loader uses them only for arity and literal-map-key checks; the full
// check happens at call time and is an ordinary error.
// ?? How much type checking do shapes buy at load time? A literal map arg
//    `{json: …, headers: …}` can be key-checked; a variable can't.
// ---------------------------------------------------------------------------

type Shape struct{ /* opaque */ }

func AnyShape() Shape
func TextShape() Shape
func NumberShape() Shape
func BytesShape() Shape
func ListOf(s Shape) Shape
func MapShape(fields ...Field) Shape // closed unless OpenMap
func OpenMap(fields ...Field) Shape
func ObjectShape(kind *ObjectKind) Shape
func OneOf(ss ...Shape) Shape
func Optional(s Shape) Shape

type Field struct {
	Key      string
	Shape    Shape
	Optional bool
}

// ---------------------------------------------------------------------------
// Capabilities and Operations (ADR 0012).
// ---------------------------------------------------------------------------

type Mode int

const (
	Immediate    Mode = iota // `ask` returns at once; not a Suspension Point
	Suspending               // `ask` suspends the Run; the Host answers later
	FireAndForget            // `tell` only; result and failure go nowhere (Host may log)
)

// Cost is the declared per-call cost (ADR 0006). It is charged before the
// Operation's Go code runs; a Run that can't cover it faults at the call.
type Cost struct {
	Fuel  int64
	Alloc int64
}

type Operation struct {
	Name   string // a literal word; `put`, `delete` are fine (ADR 0012)
	Args   []Shape
	Result Shape
	Cost   Cost
	Mode   Mode

	// Exactly one of these is set, matching Mode.
	Do    func(c *Call, args []Value) (Value, error) // Immediate
	Start func(c *Call, args []Value)                // Suspending: answer later via c.Answer/c.Fail
	Fire  func(c *Call, args []Value)                // FireAndForget
}

// A CapabilityDef is defined once per Host process and reused by every grant.
type CapabilityDef struct {
	Name string // default name Scripts use; a Grant can rename ?? should it
	Ops  []Operation
}

func DefineCapability(name string, ops ...Operation) *CapabilityDef

// A Grant binds a CapabilityDef to one Script (or one Group): which
// Operations, plus Host-private binding data (tenant id, allowed origin…)
// that each Call can read. Grants are fixed at Load (ADR 0006, 0012).
type Grant struct{ /* opaque */ }

func (d *CapabilityDef) Grant(ops []string, binding any) *Grant
func (d *CapabilityDef) GrantAll(binding any) *Grant

// Revoke makes every later call an ordinary "capability revoked" error.
// ?? In-flight Suspending calls: are they failed now, or left to finish?
//    Proposal: left alone; the Host decides by failing them itself.
func (g *Grant) Revoke()

// Call is what an Operation's code receives.
type Call struct{ /* opaque */ }

func (c *Call) ID() CallID          // deterministic, spec-visible (ADR 0005)
func (c *Call) Binding() any        // the Grant's binding
func (c *Call) Script() *Script     // for Host bookkeeping only
func (c *Call) Context() context.Context // cancelled when the Run is cancelled or its Script stops

// Charge draws Fuel from the calling Run in proportion to work, before
// doing it (ADR 0006 "budget handle"). ErrLimit means: stop, do no work,
// return ErrLimit; the Core turns it into a Limit Fault at the call.
func (c *Call) Charge(fuel int64) error

// Suspending only. Safe from any goroutine; wakes the Group (GroupOptions.OnReady).
// Converting the answer to Script values is charged to the Run on resume.
func (c *Call) Answer(v Value)
func (c *Call) Fail(e *Error)

type CallID string // e.g. "r12.c3": Run 12, its 3rd call

var ErrLimit error

// Error is an ordinary, catchable Script error raised by a Capability.
type Error struct {
	Code    string // stable, spec-style code: "http", "not found"
	Message string // wording: not covered by parity
	Data    Value  // extra fields merged into the error map
}

// ---------------------------------------------------------------------------
// Host Objects and the Message Path.
// ---------------------------------------------------------------------------

// An ObjectKind declares the properties Scripts may read and `set`, and how
// a message climbs from an object to its parent.
type ObjectKind struct {
	Name  string
	Props []Prop
	// Parent is called while dispatch walks the Message Path. It must be
	// pure and fast: dispatch never suspends (ADR 0004). nil ends the chain.
	// ?? Parity: a Host function sits inside dispatch. If it reads mutable
	//    game state, two Hosts can walk different paths. Should the Host
	//    instead set parents explicitly (obj.SetParent) so the Core owns them?
	Parent func(o *Object) *Object
	// EndOfPath says what happens when a message falls off the chain.
	EndOfPath func(o *Object, m Message) // default: report as Unhandled
}

type Prop struct {
	Name     string
	Shape    Shape
	Get      func(o *Object) Value
	Set      func(o *Object, v Value) error // nil: read-only; `set` is a load-time error ?? only if the kind is known at load
	GetCost  Cost
	SetCost  Cost
}

type Object struct{ /* opaque */ }

func (o *Object) ID() string    // the stable id the Host supplied (ADR 0008)
func (o *Object) Native() any   // the Host's own pointer
func (o *Object) Value() Value
// Dispose: later property access through any handle is an ordinary
// "disposed object" error; Scripts owned by this object are stopped.
func (o *Object) Dispose()

// ---------------------------------------------------------------------------
// Limits (ADR 0006). Defaults come from the spec's limit profile.
// ---------------------------------------------------------------------------

type Limits struct {
	FuelPerRun      int64
	AllocPerRun     int64
	PersistentState int64
	CallDepth       int
	MailboxDepth    int
	MaxWait         time.Duration // longest in-memory `wait` / `wait for` timeout
	PerHandler      map[string]Limits // ?? overrides by message name; zero fields inherit
}

func DefaultLimits() Limits

// ---------------------------------------------------------------------------
// Core, Group, Script.
// ---------------------------------------------------------------------------

type Core struct{ /* opaque */ }

func New() *Core

// A Clock is read only at scheduler boundaries (ADR 0006). It must never go
// backwards. A Group reports the next deadline it cares about; the Host
// wakes it then. The Core owns no timers and no goroutines.
type Clock interface{ Now() time.Time }

type GroupOptions struct {
	Name    string
	Clock   Clock
	Reports Reports // where Run outcomes and stops go
	Trace   TraceSink // nil: no Trace recorded
	// OnReady is called (from any goroutine, e.g. inside Call.Answer) when
	// something makes the Group runnable from outside. The Host enqueues
	// the Group for a worker. It must not call Pump itself.
	// (A first draft had `Ready() <-chan struct{}`; a Host with 10k Groups
	// can't select on 10k channels. See NOTES.md.)
	OnReady func()
}

// A Group is single-threaded: at most one goroutine may call its methods at
// a time. Different Groups may be pumped in parallel.
func (c *Core) NewGroup(o GroupOptions) *Group

type Group struct{ /* opaque */ }

type LoadOptions struct {
	Name     string            // Script name, part of code identity
	Source   string
	Grants   map[string]*Grant // name in Script → grant; the loader checks every `ask/tell`
	Owner    *Object           // optional: the Script is `me`'s script, first on its Message Path
	Limits   Limits
	Messages []MessageDecl     // Host-declared messages this Script may be sent, with shapes and modes
}

// MessageDecl lets the Host say which messages it will deliver and how.
type MessageDecl struct {
	Name     string
	Args     []Shape
	Deciding bool // decision-mode: Handlers must veto before any Suspension Point
	// Default queueing when the Handler has no suffix. ?? per message kind
	// or per Handler only? ADR 0004 left the default open.
	DefaultQueueing Queueing
}

type Queueing int

const (
	Queued Queueing = iota
	Replacing
	Dropping
	EveryTime
)

// Load compiles and checks. Diagnostics are the spec's load-time errors
// (same code and location on both Cores).
func (g *Group) Load(o LoadOptions) (*Script, []Diagnostic, error)

// Reload replaces a Script's code: stop-and-reload (ADR 0005), with
// optional carry-over of Script Variables by name. Discarded Runs are
// reported through Reports.OnStop.
func (s *Script) Reload(source string, carry CarryOver) ([]Diagnostic, error)

type CarryOver int

const (
	ResetVariables CarryOver = iota
	CarryVariables
)

type Diagnostic struct {
	Code    string
	Message string
	Line    int
	Col     int
}

type Script struct{ /* opaque */ }

func (s *Script) Name() string
func (s *Script) Counters() Counters // read-only; Host polices cumulative quotas
func (s *Script) Stop(reason string)  // Stop Script: takes effect at any step (ADR 0006)
func (s *Script) CancelRun(id RunID)

type Counters struct {
	FuelTotal       int64 // since load, including faulted Segments
	AllocTotal      int64
	Runs            int64
	Faults          int64
	PersistentState int64 // current
	MailboxLen      int
}

// ---------------------------------------------------------------------------
// Delivering messages.
// ---------------------------------------------------------------------------

type Message struct {
	Name string
	Args []Value
	To   *Object // nil: the Script itself
}

// Deliver puts a message in the Script's mailbox. It never runs Script code.
// A full mailbox is ErrMailboxFull (the Host chooses: drop, retry, 503).
func (s *Script) Deliver(m Message) error

// Request is `send … and wait` from outside: the reply (or error) arrives
// through the returned Pending once the Group has been pumped far enough.
func (s *Script) Request(m Message) (*Pending, error)

type Pending struct{ /* opaque */ }

func (p *Pending) Done() <-chan struct{}
func (p *Pending) Result() (Value, *Error, Outcome)

// Decide delivers a decision-mode message and returns a ticket. The verdict
// is known once the deciding Run has reached its veto point or ended.
// ?? A decision can't be answered synchronously if the Script is busy
//    (a Run preempted mid-Segment). The Host must either pump until the
//    ticket resolves or apply its own default. See NOTES.md.
func (s *Script) Decide(m Message) (*Decision, error)

type Decision struct{ /* opaque */ }

func (d *Decision) Resolved() bool
func (d *Decision) Vetoed() (bool, Value) // reason value

// ---------------------------------------------------------------------------
// Driving the Group. The Core owns no goroutines; the Host pumps.
// ---------------------------------------------------------------------------

type PumpOptions struct {
	// Fuel Slice: preempt a Run once it has used this much Fuel in this
	// pump; overrun carries as debt (ADR 0010). 0 = no slicing.
	// ?? Is the slice per Run, per Script or per Group? Here: per Script,
	//    so one busy Script can't starve the others in its Group.
	FuelSlicePerScript int64
	// Stop after this much Fuel across the Group (Host fairness between Groups).
	FuelCap int64
}

type PumpResult struct {
	State        GroupState
	NextDeadline time.Time // zero if no pending waits
	FuelUsed     int64
}

type GroupState int

const (
	Idle      GroupState = iota // nothing runnable; waiting on deliveries, calls or deadlines
	Sliced                      // Fuel Slice or FuelCap reached; runnable work remains
	Stopped
)

// Pump reads the Clock once, fires due waits, and runs Runs until nothing is
// runnable or the slice is spent. The Group is Quiescent when Pump returns.
func (g *Group) Pump(o PumpOptions) PumpResult


// ---------------------------------------------------------------------------
// Reports.
// ---------------------------------------------------------------------------

type Reports interface {
	OnRunEnd(r RunReport)
	OnStop(r StopReport)
	OnUnhandled(s *Script, m Message) // fell off the end of the Message Path
}

type RunID string

type Outcome int

const (
	Completed Outcome = iota
	Errored            // an uncaught ordinary error
	LimitFault         // Segment rolled back (ADR 0006)
	Cancelled          // `, replacing`, CancelRun, or Stop
	Unhandled
)

type RunReport struct {
	Script  *Script
	Run     RunID
	Handler string
	Outcome Outcome
	Error   *Error   // Errored
	Limit   string   // LimitFault: "fuel", "alloc", "persistent", "depth"
	At      Location // fault or error location
	Fuel    int64
	Alloc   int64
}

type StopReport struct {
	Script        *Script
	Reason        string
	DiscardedRuns []RunID
	PendingCalls  []CallID // their Call.Context() is cancelled
}

type Location struct {
	Line, Col int
	Handler   string
	PC        int // instruction index (ADR 0010)
}

// ---------------------------------------------------------------------------
// Save and restore (ADR 0008). Whole Groups, same core family only.
// ---------------------------------------------------------------------------

// Save is legal whenever the Group is Quiescent, i.e. between Pumps.
func (g *Group) Save() ([]byte, error)

type RestoreOptions struct {
	Clock    Clock
	Reports  Reports
	Trace    TraceSink
	Grants   func(script, name string) *Grant // re-bind grants by Script and name
	Resolve  func(kind, id string) (*Object, bool)  // stable id → live object
	Settle   func(p PendingCall) Settlement
	Mismatch MismatchPolicy
}

type PendingCall struct {
	ID        CallID
	Script    string
	Capability string
	Operation string
	Args      []Value
}

// Settlement: exactly one of Answer, Fail, Reissue.
type Settlement struct {
	Answer  *Value
	Fail    *Error
	Reissue bool // run Start again; its per-call cost is not charged twice
}

type MismatchPolicy int

const (
	RejectMismatch MismatchPolicy = iota
	VariablesOnly
)

func (c *Core) Restore(save []byte, o RestoreOptions) (*Group, *RestoreReport, error)

type RestoreReport struct {
	VariablesOnly bool
	DiscardedRuns []RunID
	Disposed      []string // object ids that didn't resolve
}

// ---------------------------------------------------------------------------
// Traces (ADR 0009). The canonical text form is what parity compares.
// ---------------------------------------------------------------------------

type TraceSink interface{ Record(line string) } // one canonical Trace line per record
