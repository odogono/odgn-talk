package northtalk

import "time"

type LoadError struct {
	Diagnostics []Diagnostic
}

type Diagnostic struct {
	Code    string // from the diagnostic catalogue
	Message string // wording: not covered by parity
	Unit    string // the Script or Library the diagnostic is in
	Line    int
	Col     int
}

type Versions struct {
	Language   string // "1.0"
	CostModel  string // versioned with the Abstract Machine
	Unicode    string
	Core       string // "go/0.1.0": informational
	SaveFormat string // same-core only (ADR 0008)
}

type GroupOptions struct {
	Name string
	// OnReady is called, from any goroutine, when a queued Host Input makes
	// the Group runnable. The Host puts the Group on its run queue. It must
	// not pump from inside the callback.
	OnReady func()
	Trace   TraceSink // nil: no Trace is recorded
}

type TraceSink interface{ Record(line string) }

type LoadOptions struct {
	Name   string
	Source string
	// Grants maps the name the Script uses to a Grant, so one Capability can
	// be granted twice under two names with different bindings.
	Grants map[string]*Grant
	// GrantsAsUsed keeps only the granted Operations that the Script and its
	// Libraries use plus implicit abandonment dependencies, trimming once at Load.
	GrantsAsUsed bool
	Owner        *Object            // the Script becomes its Owning Script
	Objects      map[string]*Object // well-known objects, bound by name
	Limits       Limits
}

type Limits struct {
	FuelPerRun      int64
	AllocPerRun     int64
	PersistentState int64 // Script-wide; never overridden per Delivery
	CallDepth       int
	PatternSize     int // Text Pattern program instructions; never overridden per Delivery
	MailboxDepth    int
	MaxWait         time.Duration // whole milliseconds; anything finer is "invalid value"
	MaxJoin         int
	CleanupBudget   int64
}

type LimitOverride struct {
	FuelPerRun  int64
	AllocPerRun int64
	MaxWait     time.Duration // whole milliseconds
	MaxJoin     int
}

type Message struct {
	Name   string
	Args   []Value
	Limits *LimitOverride
}

type DeliveryID string

type BroadcastID string

type RunID string

type CallID string

type PumpOptions struct {
	FuelSlice int64 // per Script, per Pump; overrun is carried as debt. 0: no slicing
	FuelCap   int64 // across the Group, for fairness between Groups. 0: no cap
}

type PumpResult struct {
	State        GroupState
	NextDeadline time.Time // zero if nothing is waiting on time
	FuelUsed     int64
	Reports      []Report // in the order they happened
}

type GroupState int

type Inspection struct {
	Scripts []ScriptView // in load order
}

type ScriptView struct {
	DisabledGrants []string // disabled named Grants, in code-point order; empty when none
	Name           string
	Vars           []Pair        // its Script Variables, in declaration order
	Runs           []RunView     // every Run that hasn't ended, in the order they started
	Mailbox        []MessageView // in mailbox order
}

type RunView struct {
	ID      RunID
	Status  RunStatus
	Handler string    // its Handler, or the display form of the Function Value it runs
	Wait    string    // Suspended: the `seg` end reason it suspended at (chapter 11)
	Until   time.Time // Suspended: its deadline, if it has one
	Calls   []CallID  // Suspended: the calls, replies or Join Members it waits for
}

type RunStatus int

type MessageView struct {
	Delivery DeliveryID // empty for a message a Script sent
	From     string     // for a message a Script sent, the call or Run that sent it
	Message  Message
}

type Counters struct {
	FuelTotal       int64 // since load, including faulted Segments; carried over a Reload
	AllocTotal      int64
	Runs            int64
	Faults          int64
	PersistentState int64 // current
	MailboxLen      int
}

type Report interface{ isReport() }

type Outcome int

type RunEnd struct {
	Script        string
	Run           RunID       // empty for a Delivery cancelled before it started
	Delivery      DeliveryID  // empty for a Run started by another Script's send
	Broadcast     BroadcastID // empty unless the Delivery was a Broadcast's
	Handler       string
	Outcome       Outcome
	Effect        *EffectFailure  // EffectFailureOutcome
	CleanupFailed *CleanupFailure // Cancelled, only when its cleanup failed
	Result        Value           // Completed
	Error         *ScriptError    // Errored
	Limit         string          // LimitFault: "fuel", "alloc", "persistent", "depth", "pattern", "join"
	At            Location
	Fuel          int64
	Alloc         int64
}

type CleanupFailure struct {
	Code  string // the error's code, or empty when a limit ended cleanup
	Limit string // "cleanup", "alloc", "persistent", "depth", "pattern", "join", or empty for an error
}

type Location struct {
	Unit    string // Script or Library
	Line    int
	Col     int
	Handler string
	PC      int // instruction index (ADR 0010)
}

type EffectFailure struct {
	Script  string
	Run     RunID
	Grant   string
	Segment string
	Phase   string       // "abandon", "begin", "commit", "rollback"
	Status  EffectStatus // failed or unknown
	Scope   string       // abandonment only
	Detail  string       // Host-only; outside parity
}

type EffectStatus string

const (
	Idle   GroupState = iota // nothing runnable until an input or a deadline
	Sliced                   // a slice or the cap ran out with work left
	Stopped
)

const (
	Ready RunStatus = iota
	Suspended
	Parked
	Preempted
)

const (
	Completed Outcome = iota
	Errored
	LimitFault
	Cancelled
	UnhandledOutcome
	Dropped
	EffectFailureOutcome // "effect failed"
)

const (
	EffectOK      EffectStatus = "ok"
	EffectFailed  EffectStatus = "failed"
	EffectUnknown EffectStatus = "unknown"
)

type Grant struct{}

type Unhandled struct {
	Delivery DeliveryID
	Message  Message
	Target   *Object
}
