// Package value holds the shared value model, used by the Go embedding seam
// and the internal Abstract Machine. Constructors own and normalize inputs.
package value

import (
	"bytes"
	"fmt"
	"math/big"
	"slices"
	"strings"
	"sync/atomic"

	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	coreunicode "github.com/odogono/odgn-talk/impl/go/internal/unicode"
)

type Kind uint8

const (
	Nothing Kind = iota
	Boolean
	Number
	Quantity
	Text
	Bytes
	List
	Map
	Range
	Instant
	CivilDate
	Pattern
	Function
	Object
	Iterator
	BinaryReader
	Replacement
	Deadline
)

var KindNames = []string{"nothing", "boolean", "number", "quantity", "text", "bytes", "list", "map", "range", "instant", "civil date", "pattern", "function", "object", "iterator", "reader", "replacement", "deadline"}

type DateFields struct {
	Year, Month, Day                 int
	HasTime                          bool
	Hour, Minute, Second, Nanosecond int
}
type Pair struct {
	Key string
	Val Value
}
type ObjectData struct {
	Kind, ID string
	Handle   any
	Disposed *atomic.Bool // Core lifecycle state; identity and encoding ignore it.
}
type FunctionData struct {
	CodeState any
	Body      int
	Owner     any
	Group     any
	Name      string
	// Arity is value metadata, retained even when a save drops stale code.
	Required, Total int
	Home, Code      string
	Captures        []Pair
}

// IteratorData is private machine state retained by an internal value.
// Advancement copies it before rebinding the iterator.
type IteratorData struct {
	Snapshot  Value
	Position  int
	Remaining decimal.Number
	Current   decimal.Number
	Done      bool
}

// Fields are internal to the Core. Consumers must rebind values rather than
// mutate their container slices or metadata; constructors copy all slices.
type ReaderData struct {
	Snapshot Value
	Position int
}

type ReplacementData struct {
	Subject      Value
	Matches      []Value
	Position, At int
	Parts        []string
}

// DeadlineData is a Timeout Block's deadline, kept on the stack below its
// body: the Instant in Clock nanoseconds, and the block's duration as a
// Quantity in `ms` (ADR 0073).
type DeadlineData struct {
	At    *big.Int
	After Value
}

// Value is a compact tagged value. A container slot holds only its kind,
// flags and an immutable payload, rather than metadata for every value kind.
// Copies share payloads; transformations rebind rather than mutate them.
type Value struct {
	_           [0]func() // Payloads can contain slices; Values are not map keys.
	Kind        Kind
	CoreMessage bool
	Bool        bool
	list        *listView
	data        any
}

// Fields is temporary construction data and the stable snapshot wire layout.
// It is never stored as a container element. Internal callers own the supplied
// slices and metadata; public constructors copy and normalize their inputs.
type Fields struct {
	// CoreMessage marks only a Core-generated error message. It is visible to
	// Scripts but omitted from parity Trace values (chapter 11).
	CoreMessage bool

	Reader      *ReaderData
	Replacement *ReplacementData
	Iterator    *IteratorData
	Deadline    *DeadlineData
	Kind        Kind
	Bool        bool
	Number      decimal.Number
	Text        string
	Bytes       []byte
	Items       []Value
	list        *listView
	Entries     []Pair
	Unit        Unit
	Date        DateFields
	Seconds     int64
	Nanos       int32
	Object      *ObjectData
	Function    *FunctionData
}

type quantityData struct {
	number decimal.Number
	unit   Unit
}
type instantData struct {
	seconds int64
	nanos   int32
}

func (f Fields) Value() Value {
	v := Value{Kind: f.Kind, CoreMessage: f.CoreMessage, Bool: f.Bool, list: f.list}
	switch f.Kind {
	case Number:
		v.data = f.Number
	case Quantity:
		v.data = quantityData{f.Number, f.Unit}
	case Text, Pattern:
		v.data = f.Text
	case List, Range:
		v.data = f.Items
	case Bytes:
		v.data = f.Bytes
	case Map:
		v.data = f.Entries
	case CivilDate:
		v.data = f.Date
	case Instant:
		v.data = instantData{f.Seconds, f.Nanos}
	case Object:
		v.data = f.Object
	case Function:
		v.data = f.Function
	case Iterator:
		v.data = f.Iterator
	case BinaryReader:
		v.data = f.Reader
	case Replacement:
		v.data = f.Replacement
	case Deadline:
		v.data = f.Deadline
	}
	return v
}

func (v Value) Number() decimal.Number {
	if q, ok := v.data.(quantityData); ok {
		return q.number
	}
	n, _ := v.data.(decimal.Number)
	return n
}
func (v Value) Unit() Unit     { q, _ := v.data.(quantityData); return q.unit }
func (v Value) Seconds() int64 { i, _ := v.data.(instantData); return i.seconds }
func (v Value) Nanos() int32   { i, _ := v.data.(instantData); return i.nanos }
func (v Value) WithNumber(n decimal.Number) Value {
	if v.Kind == Quantity {
		v.data = quantityData{n, v.Unit()}
	} else {
		v.data = n
	}
	return v
}
func (v Value) Items() []Value { x, _ := v.data.([]Value); return x }
func (v Value) WithItems(x []Value) Value {
	if v.Kind == List || v.Kind == Range {
		v.data = x
	}
	return v
}
func (v Value) Text() string    { x, _ := v.data.(string); return x }
func (v Value) Bytes() []byte   { x, _ := v.data.([]byte); return x }
func (v Value) Entries() []Pair { x, _ := v.data.([]Pair); return x }
func (v Value) WithEntries(x []Pair) Value {
	if v.Kind == Map {
		v.data = x
	}
	return v
}
func (v Value) Date() DateFields        { x, _ := v.data.(DateFields); return x }
func (v Value) Object() *ObjectData     { x, _ := v.data.(*ObjectData); return x }
func (v Value) Function() *FunctionData { x, _ := v.data.(*FunctionData); return x }
func (v Value) WithFunction(x *FunctionData) Value {
	if v.Kind == Function {
		v.data = x
	}
	return v
}
func (v Value) Iterator() *IteratorData       { x, _ := v.data.(*IteratorData); return x }
func (v Value) Reader() *ReaderData           { x, _ := v.data.(*ReaderData); return x }
func (v Value) Replacement() *ReplacementData { x, _ := v.data.(*ReplacementData); return x }
func (v Value) Deadline() *DeadlineData       { x, _ := v.data.(*DeadlineData); return x }

// Fields returns the snapshot representation without copying containers.
func (v Value) Fields() Fields {
	return Fields{Kind: v.Kind, CoreMessage: v.CoreMessage, Bool: v.Bool, Text: v.Text(), Items: v.Items(),
		Number: v.Number(), Unit: v.Unit(), Bytes: v.Bytes(), Entries: v.Entries(), Date: v.Date(),
		Seconds: v.Seconds(), Nanos: v.Nanos(), Object: v.Object(), Function: v.Function(),
		Iterator: v.Iterator(), Reader: v.Reader(), Replacement: v.Replacement(), Deadline: v.Deadline()}
}

func NewText(s string) (Value, error) {
	s, e := coreunicode.NFC(s)
	return Fields{Kind: Text, Text: s}.Value(), e
}
func NewMap(pairs []Pair) (Value, error) {
	out := make([]Pair, len(pairs))
	seen := map[string]bool{}
	for i, p := range pairs {
		key, e := coreunicode.NFC(p.Key)
		if e != nil {
			return Value{}, e
		}
		if seen[key] {
			return Value{}, fmt.Errorf("duplicate map key %q", key)
		}
		seen[key] = true
		out[i] = Pair{key, p.Val}
	}
	return Fields{Kind: Map, Entries: out}.Value(), nil
}
func NewBytes(b []byte) Value { return Fields{Kind: Bytes, Bytes: slices.Clone(b)}.Value() }
func NewQuantity(n decimal.Number, s string) (Value, error) {
	u, e := ParseUnit(s)
	if e != nil {
		return Value{}, e
	}
	if len(u.Slots) == 0 {
		return Fields{Kind: Number, Number: n}.Value(), nil
	}
	return Fields{Kind: Quantity, Number: n, Unit: u}.Value(), nil
}
func NewRange(a, b Value) (Value, error) {
	if a.Kind != b.Kind || a.Kind != Number && a.Kind != Quantity {
		return Value{}, fmt.Errorf("range ends must be numbers or quantities")
	}
	if a.Kind == Quantity && !a.Unit().Compatible(b.Unit()) {
		return Value{}, fmt.Errorf("range dimensions differ")
	}
	return Fields{Kind: Range, Items: []Value{a, b}}.Value(), nil
}
func (v Value) Get(key string) Value {
	key, e := coreunicode.NFC(key)
	if e != nil {
		return Value{}
	}
	for _, p := range v.Entries() {
		if p.Key == key {
			return p.Val
		}
	}
	return Value{}
}
func (v Value) Equal(w Value) bool {
	if v.Kind != w.Kind {
		return false
	}
	switch v.Kind {
	case Nothing:
		return true
	case Boolean:
		return v.Bool == w.Bool
	case Number:
		return v.Number().Compare(w.Number()) == 0
	case Quantity:
		if !v.Unit().Compatible(w.Unit()) {
			return false
		}
		return quantityOrder(v, w) == 0
	case Text, Pattern:
		return v.Text() == w.Text()
	case Bytes:
		return bytes.Equal(v.Bytes(), w.Bytes())
	case List, Range:
		if len(v.Items()) != len(w.Items()) {
			return false
		}
		for i, a := range v.Items() {
			if !a.Equal(w.Items()[i]) {
				return false
			}
		}
		return true
	case Map:
		if len(v.Entries()) != len(w.Entries()) {
			return false
		}
		for _, p := range v.Entries() {
			found := false
			for _, q := range w.Entries() {
				if p.Key == q.Key {
					found = p.Val.Equal(q.Val)
					break
				}
			}
			if !found {
				return false
			}
		}
		return true
	case CivilDate:
		return v.Date() == w.Date()
	case Instant:
		return v.Seconds() == w.Seconds() && v.Nanos() == w.Nanos()
	case Object:
		return v.Object() != nil && w.Object() != nil && v.Object().Handle == w.Object().Handle
	case Function:
		if v.Function() == nil || w.Function() == nil || v.Function().Home != w.Function().Home || v.Function().Code != w.Function().Code || v.Function().Group != w.Function().Group {
			return false
		}
		return (Fields{Kind: Map, Entries: v.Function().Captures}.Value()).Equal(Fields{Kind: Map, Entries: w.Function().Captures}.Value())
	}
	return false
}

// Compare reports the first unequal list pair, so a later unorderable value
// cannot mask an earlier ordering decision (chapter 3).
func (v Value) Compare(w Value) (int, error) {
	if v.Kind != w.Kind {
		return 0, fmt.Errorf("can't compare: %s and %s", v.Display(), w.Display())
	}
	switch v.Kind {
	case Number:
		return v.Number().Compare(w.Number()), nil
	case Quantity:
		if v.Unit().Compatible(w.Unit()) {
			return quantityOrder(v, w), nil
		}
	case Text:
		return strings.Compare(v.Text(), w.Text()), nil // UTF-8 preserves scalar order.
	case Bytes:
		return bytes.Compare(v.Bytes(), w.Bytes()), nil
	case Instant:
		if v.Seconds() != w.Seconds() {
			if v.Seconds() < w.Seconds() {
				return -1, nil
			}
			return 1, nil
		}
		return cmpInt(int(v.Nanos()), int(w.Nanos())), nil
	case CivilDate:
		if v.Date().HasTime == w.Date().HasTime {
			a, b := v.Date(), w.Date()
			for _, p := range [][2]int{{a.Year, b.Year}, {a.Month, b.Month}, {a.Day, b.Day}, {a.Hour, b.Hour}, {a.Minute, b.Minute}, {a.Second, b.Second}, {a.Nanosecond, b.Nanosecond}} {
				if c := cmpInt(p[0], p[1]); c != 0 {
					return c, nil
				}
			}
			return 0, nil
		}
	case List:
		for i := 0; i < min(len(v.Items()), len(w.Items())); i++ {
			if !v.Items()[i].Equal(w.Items()[i]) {
				return v.Items()[i].Compare(w.Items()[i])
			}
		}
		return cmpInt(len(v.Items()), len(w.Items())), nil
	}
	return 0, fmt.Errorf("can't compare: %s and %s", v.Display(), w.Display())
}
func cmpInt(a, b int) int {
	if a < b {
		return -1
	}
	if a > b {
		return 1
	}
	return 0
}
