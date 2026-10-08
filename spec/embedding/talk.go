// The NorthTalk Go Core's embedding interface: declarations only, never compiled.
// The module is github.com/odogono/odgn-talk/impl/go; this is its root package.
//
// This file and talk.ts are the handoff interface (#72). They differ only in
// idiom (ADR 0015): errors as values here and exceptions there, Start/Answer
// here and an optional Promise-returning run there, and maps built from pairs
// here and from Map or record() there. None of the differences can be observed
// by a Script. Bodies are elided. Chapter 9 of the spec (09-embedding.md)
// holds the Host error catalogue and the Operation naming guide.
//
// Shape in one breath:
//
//	Core ── NewGroup / Restore ──> Group ── Load ──> Script
//
// A Host defines Capabilities and Object Kinds once per process, on the Core.
// Everything it does to a Group is a Host Input, recorded in the Trace. Calls
// marked "any goroutine" append to the Group's input queue and return at once.
// The next Pump drains the queue in call order, right after it takes its
// Clock reading. Stop, CancelRun and RewindRun land at the latest at the running Pump's
// next Host crossing (an Operation or property call) or its end; a native
// Core may act on them sooner, between instructions. Calls marked "worker" must come from the one goroutine that
// pumps the Group. Two worker calls made at once are undefined. A worker call
// made from inside the Group's own Pump (from an Operation function, say) is
// the Host error "reentrant call".
package northtalk

import (
	"context"
	"time"
)

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// LoadError rejects source: a Script, an Entry for extend Script, or a
// Library. Its Diagnostics are the spec's load-time errors, and parity covers
// their codes and locations.
type LoadError struct {
	Diagnostics []Diagnostic
}

func (e *LoadError) Error() string

type Diagnostic struct {
	Code    string // from the diagnostic catalogue
	Message string // wording: not covered by parity
	Unit    string // the Script or Library the diagnostic is in
	Line    int
	Col     int
}

// HostError is Host misuse, refused at admission or reported by Pump at drain. Its Code comes
// from the Host error catalogue (09-embedding.md), so both Cores refuse the same
// misuse with the same code.
type HostError struct {
	Code   HostErrorCode
	Detail string // wording: not covered by parity
}

func (e *HostError) Error() string

type HostErrorCode string

const (
	ClockBackwards     HostErrorCode = "clock backwards"
	ParentCycle        HostErrorCode = "parent cycle"
	DuplicateObjectID  HostErrorCode = "duplicate object id"
	NameReused         HostErrorCode = "name reused"
	ReentrantCall      HostErrorCode = "reentrant call"
	WrongGroup         HostErrorCode = "wrong group"
	LibraryMismatch    HostErrorCode = "library mismatch"
	ReservedName       HostErrorCode = "reserved name"
	NotAdoptable       HostErrorCode = "not adoptable"
	InvalidValue       HostErrorCode = "invalid value"
	InvalidSave        HostErrorCode = "invalid save"
	SaveMismatch       HostErrorCode = "save mismatch"
	UnknownCall        HostErrorCode = "unknown call"
	StateTooLarge      HostErrorCode = "state too large"
	EffectsPending     HostErrorCode = "effects pending"
	EffectStateUnknown HostErrorCode = "effect state unknown"
)

// ErrMailboxFull is load shedding, not a bug: the Host decides whether to
// drop, retry or answer 503. It counts the Deliveries already queued to the
// Script, and a Delivery accepted at the call is never refused later.
var ErrMailboxFull error

// ScriptError is an ordinary, catchable Error inside the Script (ADR 0017).
// An Operation fails with one. The Script sees Code as `code`, Message as
// `message` and Data's entries as further fields. A catalogue code the
// Operation doesn't declare, a code outside a declared list, or a Data key
// that clashes with a reserved key (errors.toml), or Data that is neither a map
// nor Nothing, becomes `host error` instead. The Host-side detail goes only in
// the `call failed` report.
type ScriptError struct {
	Code    string
	Message string
	Data    Value // a map, or Nothing
}

func (e *ScriptError) Error() string

// ErrLimit is returned by Call.Charge when the Run can't cover the charge. The
// Operation stops, does no work and returns it. The Core turns it into a Limit
// Fault at the call.
var ErrLimit error

// ---------------------------------------------------------------------------
// Values (ADR 0030)
// ---------------------------------------------------------------------------

// Value is one immutable Script value or Host Object handle. It is built only
// through the constructors below and read only through its accessors. Every
// constructor that can be given input the value model can't hold returns a
// HostError "invalid value". Nothing is clamped, rounded or replaced.
type Value struct { /* opaque */
}

var Nothing Value

func Bool(b bool) Value
func Text(s string) (Value, error) // invalid UTF-8 is refused; NFC is applied, uncharged
func Int(i int64) Value
func Uint(u uint64) Value
func FromFloat(f float64) (Value, error)             // shortest round-trip digits; NaN, ±Inf and |f| >= 1e34 are refused; -0.0 enters as 0
func Dec(s string) (Value, error)                    // the `as number` grammar; more than 34 significant digits or |n| >= 1e34 is refused
func Quantity(n Decimal, unit string) (Value, error) // unit as spelled in a Script ("kg", "GBP"); normalised (ADR 0022)
func CivilDate(f DateFields) (Value, error)
func ParseCivilDate(s string) (Value, error) // the `as civil date` grammar
func Instant(seconds int64, nanos int32) (Value, error)
func InstantFromTime(t time.Time) Value // drops the monotonic reading and the zone
func Bytes(b []byte) Value              // copied in
func List(vs ...Value) Value

// Range builds a range from two numbers, or two Quantities of one dimension,
// kept as given (ADR 0034). Any other pair is refused.
func Range(from, to Value) (Value, error)

// Map builds a map from pairs, in the order given. A duplicate key, compared
// after NFC, is refused.
func Map(pairs ...Pair) (Value, error)

type Pair struct {
	Key string
	Val Value
}

func KV(k string, v Value) Pair

type DateFields struct {
	Year, Month, Day     int
	HasTime              bool
	Hour, Minute, Second int
	Nanosecond           int
}

type Kind int

const (
	KindNothing Kind = iota
	KindBool
	KindNumber
	KindQuantity
	KindText
	KindBytes
	KindList
	KindMap
	KindRange
	KindInstant
	KindCivilDate
	KindPattern
	KindFunction
	KindObject
)

func (v Value) Kind() Kind
func (v Value) AsBool() (bool, bool)
func (v Value) AsText() (string, bool) // always NFC
func (v Value) AsDec() (Decimal, bool)
func (v Value) AsQuantity() (Decimal, string, bool) // number and canonical unit
func (v Value) AsCivilDate() (DateFields, bool)
func (v Value) AsInstant() (seconds int64, nanos int32, ok bool)
func (v Value) AsBytes() ([]byte, bool) // a copy
func (v Value) AsObject() (*Object, bool)
func (v Value) AsRange() (from, to Value, ok bool)
func (v Value) Len() int          // list length; 0 for anything else
func (v Value) Index(i int) Value // 1-based; Nothing past the end
func (v Value) Get(key string) Value
func (v Value) Entries() []Pair // insertion order

// PatternSource gives a Text Pattern's canonical source, for display. A Host
// can't build a pattern, only pass one back unchanged.
func (v Value) PatternSource() (string, bool)

// HomeScript names a Function Value's Home Script (ADR 0025). It is the only
// read a Function Value has. A Host can't build one, and it is bound to the
// Group it came from: passing it into any other Group is "wrong group". It
// doesn't survive save and restore on the Host side.
func (v Value) HomeScript() (string, bool)

func (v Value) String() string // the display form (ADR 0018)
func (v Value) Equal(w Value) bool

// Decimal is the Core's own number. There is no coefficient/exponent API; a
// Host that wants a decimal library passes it String().
type Decimal struct { /* opaque */
}

func (d Decimal) String() string        // canonical, trailing zeros kept
func (d Decimal) Int64() (int64, error) // fails unless an integer that fits
func (d Decimal) Uint64() (uint64, error)
func (d Decimal) Float64Lossy() float64 // nearest, ties to even; every number fits (ADR 0034)

// ---------------------------------------------------------------------------
// JSON and the Value Encoding (ADRs 0021, 0030)
// ---------------------------------------------------------------------------

// DecodeJSON and EncodeJSON are ADR 0021's plain JSON rule, the same one the
// `json` Library uses. Numbers are read from their text, never via float64.
func DecodeJSON(b []byte) (Value, error)
func EncodeJSON(v Value) ([]byte, error)

// Add applies the `+` rules outside any Run, uncharged. Where `+` would
// raise, it returns that error as a *ScriptError.
func Add(a, b Value) (Value, error)

// EncodeValue writes the Value Encoding deterministically. A Function Value
// can't be encoded. DecodeValue asks resolve for each {"$object": [kind, id]}.
func EncodeValue(v Value) ([]byte, error)
func DecodeValue(b []byte, resolve func(kind, id string) (*Object, bool)) (Value, error)

// ---------------------------------------------------------------------------
// Shapes (ADRs 0015, 0030)
// ---------------------------------------------------------------------------

// A Shape is checked at load for arity, closed-map literal keys and the kind
// of each literal argument. At run time an argument that breaks its Shape
// raises `wrong kind` before the Host function runs, and a result that breaks
// its Shape ends the call as `host error`.
type Shape struct { /* opaque */
}

var (
	AnyShape       Shape
	ValueShape     Shape // every value, including nested Function Values; not a storage encoding
	NothingShape   Shape
	BoolShape      Shape
	NumberShape    Shape
	TextShape      Shape
	BytesShape     Shape
	InstantShape   Shape
	RangeShape     Shape
	CivilDateShape Shape
	PatternShape   Shape
	FunctionShape  Shape // a Function Value; any data Shape refuses one with `not encodable`
)

func QuantityOf(unit string) Shape   // exactly this Unit
func QuantityKind(kind string) Shape // any Unit of this Unit Kind ("mass", "GBP")
func ListOf(s Shape) Shape
func MapShape(fields ...Field) Shape // closed
func OpenMap(fields ...Field) Shape
func ObjectShape(kind *ObjectKind) Shape
func OneOf(ss ...Shape) Shape
func Optional(s Shape) Shape // Nothing or s; an outer Optional suffix may be omitted

type Field struct {
	Key      string
	Shape    Shape
	Optional bool
}

// ---------------------------------------------------------------------------
// Capabilities and Operations (ADRs 0012, 0015)
// ---------------------------------------------------------------------------

type Mode int

const (
	Immediate Mode = iota
	Suspending
	FireAndForget
)

// Cost is charged before the Operation's Go code runs. A Run that can't cover
// it faults at the call.
type Cost struct {
	Fuel  int64
	Alloc int64
}

// ErrorDecl declares an error code an Operation may fail with. When an
// Operation lists any, the Core enforces the list: a Fail with any other code
// is `host error` (ADRs 0017, 0033). Tooling offers `catch` completions from it
// (ADR 0028).
type ErrorDecl struct {
	Code   string
	Fields []Field
}

// Operation is one Operation Declaration paired with the Host function that
// implements it. Exactly one of Do, Start and Fire is set, matching Mode.
type Operation struct {
	Name         string  // a literal word; `ask`, `tell`, `send`, `wait` and `end` are refused
	Args         []Shape // an Optional suffix may be omitted; Host functions receive only supplied args
	Result       Shape
	Cost         Cost
	Mode         Mode
	MaxPending   time.Duration // Suspending only, whole milliseconds; 0 means the Script's MaxWait
	Errors       []ErrorDecl
	Scope        *ScopeDecl // immediate only
	SegmentBound bool       // immediate only; false by default

	Do    func(c *Call, args []Value) (Value, error) // Immediate: a *ScriptError, ErrLimit, or anything else as `host error`
	Start func(c *Call, args []Value) error          // Suspending: answer later through c
	Fire  func(c *Call, args []Value) error          // FireAndForget: runs at the call, in order; only its result is dropped
}

// ScopeDecl is exactly Opens+Abandon or Closes. The abandonment Operation
// closes the same scope, takes no arguments and returns Nothing.
type ScopeDecl struct {
	Opens   string
	Abandon string
	Closes  string
}

// SegmentContext supplies ownership and the last observed Clock, without a
// Script budget or a cancellable context. See embedding/scoped-effects.md.
type SegmentContext struct {
	Group      *Group // identity namespace, not just its name
	ScriptName string
	RunID      RunID
	GrantName  string // the first enrolled Grant
	SegmentID  string
	Binding    any
	Now        time.Time
	Grants     []SegmentGrant // enrolled, in enrollment order; Begin sees only the first
}

type SegmentGrant struct {
	GrantName string
	Binding   any
}

type EffectStatus string

const (
	EffectOK      EffectStatus = "ok"
	EffectFailed  EffectStatus = "failed"
	EffectUnknown EffectStatus = "unknown"
)

type EffectResult struct {
	Status EffectStatus
	Detail string // Host-only; outside parity
}
type SegmentLifecycle struct {
	Begin    func(SegmentContext) EffectResult
	Commit   func(SegmentContext) EffectResult
	Rollback func(SegmentContext) EffectResult
}

// CapabilityDef is defined once per process and reused by every Grant.
// Declarations are ordered by name, whatever order Ops is in.
type CapabilityDef struct { /* opaque */
}

func (d *CapabilityDef) Name() string

// Grant is a reusable template: a subset of Operations plus Host-private
// binding data (a tenant, allowed origins) that every Call reads. Each Load
// binds it to one Script under the name the Script uses.
type Grant struct { /* opaque */
}

func (d *CapabilityDef) Grant(ops []string, binding any) (*Grant, error) // an unknown Operation is refused
func (d *CapabilityDef) GrantAll(binding any) *Grant

// Call is what an Operation's Host function receives.
type Call struct { /* opaque */
}

func (c *Call) ID() CallID         // unique within the Group ("pricing/r1.c1")
func (c *Call) ScriptName() string // for Host bookkeeping; no Group calls through it
func (c *Call) Group() *Group      // worker calls remain forbidden in callbacks
func (c *Call) RunID() RunID
func (c *Call) GrantName() string
func (c *Call) SegmentID() string
func (c *Call) ScopeName() string        // empty for an Operation without scope metadata
func (c *Call) Automatic() bool          // true only for Core-triggered abandonment
func (c *Call) Binding() any             // the Grant's binding
func (c *Call) Now() time.Time           // the last observed Clock reading; never read the Host's own time
func (c *Call) Context() context.Context // cancelled when the call is abandoned (a failed Join, a cancelled Run, a stop, a timeout)

// Charge draws Fuel in proportion to work, before doing it. It is legal only
// while a Script Operation is starting, never during automatic abandonment.
func (c *Call) Charge(fuel int64) error

// Answer, AnswerWithCost and Fail settle a Suspending call. They are safe from
// any goroutine and queue a Host Input, into the Group that made the Call,
// never one restored from a save of it. An answer to a call that isn't
// pending (abandoned, its Run ended, or discarded by a restore) is ignored. AnswerWithCost carries a cost known only now, charged when
// the Run resumes, where it can fault.
func (c *Call) Answer(v Value)
func (c *Call) AnswerWithCost(v Value, fuel int64)
func (c *Call) Fail(e *ScriptError)

type CallID string

// ---------------------------------------------------------------------------
// Standard Capabilities (ADRs 0023, 0024; #71)
// ---------------------------------------------------------------------------

// The spec fixes these Operation Declarations. The Host supplies the answers
// and the per-call costs, keyed by Operation name and copied by the factory.
// Missing or invalid costs are refused with HostError `invalid value` (ch 9).
// Extra names are ignored; absent allocation is zero.
type Costs map[string]Cost

// clock: `now`, answered from Call.Now(). There is nothing to implement.
func (c *Core) ClockCapability(costs Costs) (*CapabilityDef, error)

// calendar: the binding is the default IANA zone. zone is "" when the call
// names none or Nothing. ToInstant receives a resolved disambiguation,
// defaulting to "compatible". An unknown zone fails with ScriptError `unknown zone` and Data
// {zone}, and ToInstant with "reject" in a gap or overlap fails with
// `ambiguous time` and Data {civil, zone}. These declarations list both codes,
// and the Core checks the fields (ADR 0033).
type CalendarImpl interface {
	Today(c *Call, zone string) (Value, error)
	Now(c *Call, zone string) (Value, error)
	ToCivil(c *Call, instant Value, zone string) (Value, error)
	ToInstant(c *Call, civil Value, disambiguation string, zone string) (Value, error)
	Offset(c *Call, instant Value, zone string) (Value, error)
	Zone(c *Call, zone string) (Value, error)
}

func (c *Core) CalendarCapability(impl CalendarImpl, costs Costs) (*CapabilityDef, error)

// locale: the binding is the default BCP 47 tag. Options contain all keys,
// with defaults filled in. The Core checks the effective tag's RFC 5646 syntax;
// the Host owns lookup and fallback. Every Host failure becomes host error.
// tag is "" when the call omits its tag or supplies Nothing. Omitted or
// Nothing options become the complete default map. The Core raises
// `bad locale` for malformed tags before these run.
type LocaleImpl interface {
	Compare(c *Call, a, b, opts Value, tag string) (Value, error)
	Rank(c *Call, texts, opts Value, tag string) (Value, error)
	Upper(c *Call, s Value, tag string) (Value, error)
	Lower(c *Call, s Value, tag string) (Value, error)
	NumberSymbols(c *Call, tag string) (Value, error)
	MonthNames(c *Call, opts Value, tag string) (Value, error)
	DayNames(c *Call, opts Value, tag string) (Value, error)
	Tag(c *Call, tag string) (Value, error)
}

func (c *Core) LocaleCapability(impl LocaleImpl, costs Costs) (*CapabilityDef, error)

// timer: both Operations are fire-and-forget. The Host stores timers durably,
// by Script and name, and when one is due it calls Script.Deliver itself.
type TimerImpl interface {
	Schedule(c *Call, name string, at Value, message string, args Value) error
	Cancel(c *Call, name string) error
}

func (c *Core) TimerCapability(impl TimerImpl, costs Costs) (*CapabilityDef, error)

// console: Write shows the Value's text form. Read starts a suspending call
// and answers with text, without its line break. Read has maxPending 2147483647 ms.
type ConsoleImpl interface {
	Write(c *Call, value Value) error
	Read(c *Call) error
}

func (c *Core) ConsoleCapability(impl ConsoleImpl, costs Costs) (*CapabilityDef, error)

// store: the binding is the Store's name. The Core has checked the Shapes and
// refused an empty key with `invalid key`; fallback and by are Nothing when
// the call omits them. Set, Delete, Increment and Swap are Segment-bound: they
// act on the calling Segment's pending writes, which Commit applies and
// Rollback discards. Fail with ScriptError `can't store` {kind}, `store full`
// {limit} or `store busy` {key}, and from Increment with the error Add returns
// (chapter 7, ADR 0062).
type StoreImpl interface {
	Begin(ctx SegmentContext) EffectResult
	Commit(ctx SegmentContext) EffectResult
	Rollback(ctx SegmentContext) EffectResult
	Get(c *Call, key string, fallback Value) (Value, error)
	Set(c *Call, key string, value Value) error
	Delete(c *Call, key string) error
	Keys(c *Call, prefix string) (Value, error)
	Increment(c *Call, key string, by Value) (Value, error)
	Swap(c *Call, key string, expected, replacement Value) (bool, error)
}

// StoreCapability maps every binding to impl as one Segment Coordinator.
func (c *Core) StoreCapability(impl StoreImpl, costs Costs) (*CapabilityDef, error)

// ---------------------------------------------------------------------------
// Host Objects (ADRs 0012, 0016)
// ---------------------------------------------------------------------------

// Prop is a Host Object property. Get and Set run inside the Run, like an
// immediate Operation, and their costs are charged the same way. Set nil
// makes the property read-only: a `set` is a load error where the kind is
// known at load, and `read only` at run time otherwise. Reading or setting a
// property of a disposed object raises `object gone`.
type Prop struct {
	Name    string
	Shape   Shape
	Get     func(o *Object) (Value, error)
	Set     func(o *Object, v Value) error
	GetCost Cost
	SetCost Cost
}

type ObjectKindDef struct {
	Name  string
	Props []Prop
	// ParentKinds lists the kinds that may be this kind's parent, for the
	// Host Manifest only. SetParent doesn't check it.
	ParentKinds []string
}

type ObjectKind struct { /* opaque */
}

// Object is a Group-scoped handle to something the Host owns.
type Object struct { /* opaque */
}

func (o *Object) ID() string // the stable id the Host supplied (ADR 0008)
func (o *Object) Kind() *ObjectKind
func (o *Object) Native() any
func (o *Object) Value() Value

// ---------------------------------------------------------------------------
// Limits (ADRs 0006, 0015, 0026; #71)
// ---------------------------------------------------------------------------

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

// DefaultLimits is the spec's default limit profile. Zero fields in
// LoadOptions.Limits take these values.
func DefaultLimits() Limits

// LimitOverrideFields marks explicitly supplied fields, including zero values.
// Nonzero fields are always supplied, preserving the numeric-only API.
type LimitOverrideFields uint8

const (
	OverrideFuelPerRun LimitOverrideFields = 1 << iota
	OverrideAllocPerRun
	OverrideMaxWait
	OverrideMaxJoin
)

// LimitOverride tightens a Script's per-Run limits for one Delivery. A field
// that would loosen a limit is "invalid value". Zero fields do not override
// unless marked in Set.
type LimitOverride struct {
	Set         LimitOverrideFields // zero numeric fields override only when marked here
	FuelPerRun  int64
	AllocPerRun int64
	MaxWait     time.Duration // whole milliseconds
	MaxJoin     int
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

// Core is process-wide. It holds the compile cache, so Scripts and Libraries
// with the same code identity compile once, and it defines Capabilities and
// Object Kinds. All its methods are safe from any goroutine.
type Core struct { /* opaque */
}

func New() *Core

func (c *Core) DefineCapability(name string, ops ...Operation) (*CapabilityDef, error)

// DefineSegmentCapability is DefineCapability with all three synchronous hooks.
// Each Grant is its own Segment Coordinator.
func (c *Core) DefineSegmentCapability(name string, lifecycle SegmentLifecycle, ops ...Operation) (*CapabilityDef, error)

// DefineCoordinatedCapability maps each binding to its Segment Coordinator
// once, when a Grant is created. Grants mapped to one pointer share a
// Segment's participant.
func (c *Core) DefineCoordinatedCapability(name string, coordinator func(binding any) *SegmentLifecycle, ops ...Operation) (*CapabilityDef, error)
func (c *Core) DefineObjectKind(k ObjectKindDef) (*ObjectKind, error)

type Versions struct {
	Language   string // "1.0"
	CostModel  string // versioned with the Abstract Machine
	Unicode    string
	Core       string // "go/0.1.0": informational
	SaveFormat string // same-core only (ADR 0008)
}

func CoreVersions() Versions

type GroupOptions struct {
	Name string
	// OnReady is called, from any goroutine, when a queued Host Input makes
	// the Group runnable. The Host puts the Group on its run queue. It must
	// not pump from inside the callback.
	OnReady func()
	Trace   TraceSink // nil: no Trace is recorded
}

func (c *Core) NewGroup(o GroupOptions) *Group

// TraceSink receives the Trace one canonical line at a time (ADR 0018).
type TraceSink interface{ Record(line string) }

// ---------------------------------------------------------------------------
// Libraries (ADR 0020; #71)
// ---------------------------------------------------------------------------

// GrantDecls gives compile-time modes and argument Shapes by the Grant name in source.
type OperationCheck struct {
	Mode Mode
	Args []Shape
}
type GrantDecls map[string]map[string]OperationCheck

type LibrarySource struct {
	Name    string
	Version string // the Host's own label
	Source  string
}

// CompileLibrary parses and checks a Library once per process. imports must
// hold every Library its `use` lines name. A missing one, or a cycle, is a
// LoadError.
func (c *Core) CompileLibrary(src LibrarySource, imports []*Library, declarations GrantDecls) (*Library, error)

type Library struct { /* opaque */
}

func (l *Library) Name() string
func (l *Library) Version() string
func (l *Library) Source() string
func (l *Library) Identity() [32]byte
func (l *Library) Imports() []*Library
func (l *Library) Needs() []OperationRef // every Operation it uses, through its imports too

type OperationRef struct {
	Capability string
	Operation  string
}

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

// Group is one Script Group. It is single-threaded: worker calls come from
// the goroutine that pumps it. Groups pump in parallel.
type Group struct { /* opaque */
}

func (g *Group) Name() string
func (g *Group) Script(name string) *Script // nil if none

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

// Load is a worker call. The Script's imports resolve against the Libraries
// already added to the Group.
func (g *Group) Load(o LoadOptions) (*Script, error)

// AddLibrary is a worker call and a Host Input. It fails with "name reused"
// if the Group holds that name, "reserved name" for a stdlib name, and
// "library mismatch" if the Group holds a different identity for one of the
// Library's imports.
func (g *Group) AddLibrary(l *Library) error

// ReplaceLibrary is a worker call and one Host Input. The Core recompiles
// every Library that imports it, from the source it already holds, and then
// stop-and-reloads every importing Script. It is atomic: if any of them fails
// to check, nothing changes and the LoadError holds every diagnostic.
func (g *Group) ReplaceLibrary(l *Library, carry CarryOver) ([]Report, error)

type CarryOver int

const (
	ResetVariables CarryOver = iota
	CarryVariables
)

// Object makes a handle for a Host-owned thing, the first time it crosses
// into this Group. A duplicate id within the kind is "duplicate object id".
// Any goroutine.
func (g *Group) Object(kind *ObjectKind, id string, native any) (*Object, error)

// ObjectByID returns the handle with this Object Kind name and id, disposed
// or not, and false if the Group never made one. It is how a Host reaches the
// handles Restore made, and it fits DecodeValue's resolve. Any goroutine.
func (g *Group) ObjectByID(kind, id string) (*Object, bool)

// SetParent and Dispose are any-goroutine calls, queued as Host Inputs.
// Their errors ("parent cycle", setParent on a disposed object) are reported
// as HostErrors when they are known at the call, and otherwise go into the
// next Pump's reports.
func (g *Group) SetParent(o, parent *Object) error // parent nil ends the chain
func (g *Group) Dispose(o *Object) error

// Message is what a Delivery carries. Handler and message names are one word.
type Message struct {
	Name   string
	Args   []Value
	Limits *LimitOverride
}

type DeliveryID string
type BroadcastID string

// Deliver routes by object to its Owning Script, or the nearest ancestor that
// has one (ADR 0016). Any goroutine. The only errors are ErrMailboxFull,
// "wrong group" and "invalid value". A disposed target is reported, since
// disposal is queued too.
func (g *Group) Deliver(to *Object, m Message) (DeliveryID, error)

// Request is `send … and wait` from outside. Any goroutine. Cancelling ctx
// queues the Host Input cancel-delivery: it cancels the Run the Delivery
// started, or, if the Delivery is still in the mailbox, removes it and
// reports a RunEnd with outcome Cancelled and no Run or Handler.
func (g *Group) Request(ctx context.Context, to *Object, m Message) (DeliveryID, *Pending, error)

// Broadcast reaches only the Scripts that want the message when the queue is
// drained. Each recipient's `run end` report carries its own Delivery id and
// this broadcast id. Any goroutine.
func (g *Group) Broadcast(m Message) (BroadcastID, error)

// Call calls a Function Value from the Host: a Delivery to its Home Script,
// shaped exactly like Request. Staleness is checked when the queue is
// drained, and a stale value rejects the Pending with `send failed`, reason
// `function gone`, before anything runs. Any goroutine.
func (g *Group) Call(ctx context.Context, fn Value, args []Value, limits *LimitOverride) (DeliveryID, *Pending, error)

// Pending settles when a Pump ends the Run it started.
type Pending struct { /* opaque */
}

func (p *Pending) Done() <-chan struct{}
func (p *Pending) Result() (Value, *ScriptError) // `send failed` with its reason when the Run didn't complete

// Decide asks whether something may happen (ADR 0031). It routes like
// Deliver, and the first `, deciding` Handler Clause it reaches holds the
// Verdict until the end of that Run's first Segment. Any goroutine.
// Cancelling ctx before the Verdict is sealed queues cancel-delivery and
// settles it Undecided with outcome Cancelled. Cancelling after does nothing.
func (g *Group) Decide(ctx context.Context, to *Object, m Message) (DeliveryID, *Deciding, error)

// DecideBroadcast asks every Script that wants m when the queue is drained,
// and settles once each recipient has sealed. Any goroutine.
func (g *Group) DecideBroadcast(ctx context.Context, m Message) (BroadcastID, *Deciding, error)

// Deciding settles when a Pump seals the Verdict, often before the deciding
// Run ends.
type Deciding struct { /* opaque */
}

func (d *Deciding) Done() <-chan struct{}
func (d *Deciding) Decided() *Decided

type PumpOptions struct {
	FuelSlice int64 // per Script, per Pump; overrun is carried as debt. 0: no slicing
	FuelCap   int64 // across the Group, for fairness between Groups. 0: no cap
}

// Pump is a worker call. It takes now as its one Clock reading (the
// monotonic reading and zone are ignored), drains the input queue, fires due
// waits and runs Runs until nothing is runnable or a slice is spent. The
// Group is Quiescent when it returns. A reading earlier than the previous
// Pump's is "clock backwards". A game pauses by not pumping, and freezes time
// by passing the same now.
func (g *Group) Pump(now time.Time, o PumpOptions) (PumpResult, error)

type PumpResult struct {
	State        GroupState
	NextDeadline time.Time // zero if nothing is waiting on time
	FuelUsed     int64
	Reports      []Report // in the order they happened
}

type GroupState int

const (
	Idle   GroupState = iota // nothing runnable until an input or a deadline
	Sliced                   // a slice or the cap ran out with work left
	Stopped
	Rewound // a Rewind landed, and the Pump returned at once (ADR 0068)
)

// Save is a worker call between Pumps. Live scopes, an enlisted participant
// or fatal effect uncertainty return EffectsPending without advancing execution.
func (g *Group) Save() ([]byte, error)

// Fingerprint is the Group Fingerprint (ADR 0009), the one lockstep check.
// A worker call, between Pumps.
func (g *Group) Fingerprint() [32]byte

// Inspect reads the Group without changing it: every Script's Script
// Variables, Runs and mailbox. A worker call, between Pumps, and the Host
// Input `vars`, which writes a `vars` record for each Script (chapter 11).
// A REPL renders :vars, :runs and :mailbox from it (chapter 12).
func (g *Group) Inspect() Inspection

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

const (
	Ready RunStatus = iota
	Suspended
	Parked
	Preempted
)

type MessageView struct {
	Delivery DeliveryID // empty for a message a Script sent
	From     string     // for a message a Script sent, the call or Run that sent it
	Message  Message
}

// ---------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------

type Script struct { /* opaque */
}

func (s *Script) Name() string
func (s *Script) Grants() map[string][]string // worker; a fresh map of kept names, including revoked and disabled Grants
func (s *Script) Counters() Counters          // worker, between Pumps

// Reload is stop-and-reload (ADR 0005), a worker call. It returns the
// reports for the Runs it discarded. KeepMailbox keeps the mailbox, a
// rewound message included (ADR 0068).
func (s *Script) Reload(source string, carry CarryOver, o ...ReloadOptions) ([]Report, error)

type ReloadOptions struct {
	KeepMailbox bool
}

// Extend is extend Script (ADR 0014), a worker call. It adds only new names.
// A reused one is "name reused", and the Host reloads instead.
func (s *Script) Extend(source string) error

// Stop, CancelRun, RewindRun and Revoke are any-goroutine Host Inputs. Stop,
// CancelRun and RewindRun land at the latest at the running Pump's next Host
// crossing or its end. Everything else waits for the next Pump.
func (s *Script) Stop(reason string)
func (s *Script) CancelRun(id RunID)

// RewindRun puts a Run still in its first Segment back in the mailbox as its
// message (ADR 0068).
func (s *Script) RewindRun(id RunID)

// Revoke makes later calls through the named Grant fail with `capability
// revoked` until the next Reload, and load errors after it. In-flight calls
// are left to the Host.
func (s *Script) Revoke(grantName string)

// Deliver and Request address the Script rather than an object.
func (s *Script) Deliver(m Message) (DeliveryID, error)
func (s *Script) Request(ctx context.Context, m Message) (DeliveryID, *Pending, error)
func (s *Script) Decide(ctx context.Context, m Message) (DeliveryID, *Deciding, error)

type Counters struct {
	FuelTotal       int64 // since load, including faulted Segments; carried over a Reload
	AllocTotal      int64
	Runs            int64
	Faults          int64
	PersistentState int64 // current
	MailboxLen      int
}

// ---------------------------------------------------------------------------
// Reports (ADR 0015)
// ---------------------------------------------------------------------------

// Report includes *HostError for drain-time Host refusals, alongside execution,
// lifecycle, Decision and accounting reports. Hosts switch
// on its type. Accounting also adds *RunStarted, *RunDiscarded,
// *RunAccounting and *CausalWork.
type Report interface{ isReport() }

func (*HostError) isReport()

type RunID string

// RunAncestry is ordinary Host Delivery ancestry, retained across saves.
type RunAncestry struct {
	RootDelivery DeliveryID
	ParentRun    RunID  // empty for a root Run
	ParentCall   CallID // empty unless spawned through a call
}

type RunStarted struct {
	RunAncestry
	Script   string
	Run      RunID
	Delivery DeliveryID
	Selector string // empty for a Function Value invocation
	Function *Value // present instead of Selector for a Function Value invocation
	Args     []Value
}

type RunDiscarded struct {
	RunAncestry
	Script string
	Run    RunID
	Reason string // stop, reload, library replacement, variables-only restore, or rewind
}

type RunAccounting struct {
	RunAncestry
	Script string
	Run    RunID
	Fuel   int64  // lifetime cumulative, including observation/cleanup charges
	State  string // "live", "terminal" or "discarded"
}

type CausalWork struct {
	RootDelivery      DeliveryID
	LiveRuns          int64
	QueuedMessages    int64
	DiscardedMessages int64 // cumulative lifecycle discards
}

type Outcome int

const (
	Completed Outcome = iota
	Errored
	LimitFault
	Cancelled
	UnhandledOutcome // named separately from the *Unhandled report
	Dropped
	EffectFailureOutcome // "effect failed"
)

type RunEnd struct {
	Script        string
	Run           RunID       // empty for a Delivery cancelled before it started
	Delivery      DeliveryID  // empty for a Run started by another Script's send
	Broadcast     BroadcastID // empty unless the Delivery was a Broadcast's
	Handler       string
	Fallback      bool // a Fallback Handler clause ran it; Handler is then the message's Selector
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

type Stop struct {
	Script          string
	Reason          string // the Host's reason, or "owner disposed"
	DiscardedRuns   []RunID
	DroppedMessages []DeliveryID
	PendingCalls    []CallID // their Contexts are cancelled
}

// Unhandled is a message that reached the end of its Message Path, or a
// Delivery to an object with no Owning Script on its path. A Broadcast is
// never reported as unhandled.
type Unhandled struct {
	Delivery DeliveryID
	Message  Message
	Target   *Object // nil for a message addressed to a Script
}

// CallFailed carries the Host-side detail of a call the Script saw as `host
// error`: a result that broke its Shape, a catalogue code in a Fail, or a Host
// function returning an error that isn't a ScriptError or ErrLimit.
type CallFailed struct {
	Script    string
	Call      CallID
	Operation OperationRef
	Detail    string
}

// EffectFailure reports lifecycle failure without raising a Script Error.
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

// Decided is a Decision's Verdict, returned by the Pump that sealed it
// (ADR 0031). Vetoes and Undecided are in recipient order.
type Decided struct {
	Delivery  DeliveryID  // empty for a Broadcast Decision
	Broadcast BroadcastID // empty unless it was DecideBroadcast's
	Verdict   Verdict
	Vetoes    []Veto
	Undecided []UndecidedBy
}

type Verdict int

const (
	Allowed   Verdict = iota
	Vetoed            // some Run reached `veto`
	Undecided         // a deciding Run failed, was cancelled, dropped or stopped before sealing; the Host chooses
)

type Veto struct {
	Script string
	Run    RunID
	Reason Value // Nothing for a bare `veto`
}

type UndecidedBy struct {
	Script  string
	Run     RunID // empty for a Delivery that never started
	Outcome Outcome
}

type Location struct {
	Unit    string // Script or Library
	Line    int
	Col     int
	Handler string
	PC      int // instruction index (ADR 0010)
}

// ---------------------------------------------------------------------------
// Save and restore (ADR 0008)
// ---------------------------------------------------------------------------

type RestoreOptions struct {
	Name      string
	OnReady   func()
	Trace     TraceSink
	Libraries []*Library // compiled Libraries matching the saved identities
	// Grants re-binds each Script's Grants by Script and name. Resolve turns
	// a stable id into a live object; an id it can't resolve restores as a
	// disposed Host Object.
	Grants   func(script, name string) *Grant
	Resolve  func(kind, id string) (native any, ok bool)
	Mismatch MismatchPolicy
}

type MismatchPolicy int

const (
	RejectMismatch MismatchPolicy = iota
	VariablesOnly
)

// Restore is safe from any goroutine; the Group it returns has not been
// pumped. The first Pump reads a Clock at or after the saved reading.
func (c *Core) Restore(save []byte, o RestoreOptions) (*Group, RestoreResult, error)

type RestoreResult struct {
	Reports       []Report // accounting baseline, including saved work discarded on restore
	VariablesOnly bool
	Pending       []PendingCall // each must be settled before the first Pump
	DiscardedRuns []RunID
	Disposed      []ObjectRef // the Host Objects that didn't resolve
	// A variables-only restore also lists what it discarded (10-save-and-restore.md).
	DroppedMessages []DeliveryID
	AbandonedCalls  []CallID
}

type ObjectRef struct{ Kind, ID string }

type PendingCall struct {
	ID        CallID
	Script    string
	Grant     string // the granted name the call went through
	Operation OperationRef
	Args      []Value
}

// Settle settles one restored call before the first Pump. Any goroutine; it
// is queued, and the first Pump drains it. A call id that isn't pending, one
// already settled, or a Settle once the first Pump has started, is refused at
// the call with "unknown call". A call still unsettled at the first Pump fails
// as `call lost`. For adopt it returns the Call the Host answers or fails
// through, and nil otherwise.
func (g *Group) Settle(id CallID, s Settlement) (*Call, error)

// Settlement is exactly one of these.
type Settlement struct {
	Answer  *Value
	Fail    *ScriptError
	Reissue bool // run Start again; its per-call cost is not charged twice
	Adopt   bool // the Host still has it and will answer under the same id; costs nothing
}

// ---------------------------------------------------------------------------
// Host Manifest (ADR 0028)
// ---------------------------------------------------------------------------

// ManifestSpec describes one kind of Script for tooling. It uses the same
// Grants and object types as LoadOptions, so one Host config builds both.
type ManifestSpec struct {
	Kind        string // "tenant rule", "game NPC"
	Version     string // the Host's own manifest version
	Grants      map[string]*Grant
	Libraries   []*Library
	Messages    []MessageDecl
	ObjectKinds []*ObjectKind
	Objects     map[string]*ObjectKind // well-known names bound at load
}

// MessageDecl is tooling-only: the Core never checks a Delivery against it.
type MessageDecl struct {
	Name      string
	Args      []Shape
	Receivers []*ObjectKind // the kinds of object it is delivered to; empty for a Script-addressed message
}

// ExportManifest writes the Host Manifest as deterministic JSON (09-embedding.md).
// It is a pure function of the definitions, not of a live Group, and it never
// includes Grant bindings.
func ExportManifest(m ManifestSpec) ([]byte, error)
