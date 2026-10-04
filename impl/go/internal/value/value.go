// Package value holds the shared value model, used by the Go embedding seam
// and the internal Abstract Machine. Constructors own and normalize inputs.
package value

import (
	"bytes"
	"fmt"
	"slices"
	"strings"

	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	coreunicode "github.com/odogono/odgn-talk/impl/go/internal/unicode"
)

type Kind int

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
)

var KindNames = []string{"nothing", "boolean", "number", "quantity", "text", "bytes", "list", "map", "range", "instant", "civil date", "pattern", "function", "object", "iterator", "reader", "replacement"}

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
}
type FunctionData struct {
	CodeState  any
	Body       int
	Owner      any
	Group      any
	Name       string
	Home, Code string
	Captures   []Pair
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

type Value struct {
	// CoreMessage marks only a Core-generated error message. It is visible to
	// Scripts but omitted from parity Trace values (chapter 11).
	CoreMessage bool

	Reader      *ReaderData
	Replacement *ReplacementData
	Iterator    *IteratorData
	Kind        Kind
	Bool        bool
	Number      decimal.Number
	Text        string
	Bytes       []byte
	Items       []Value
	Entries     []Pair
	Unit        Unit
	Date        DateFields
	Seconds     int64
	Nanos       int32
	Object      *ObjectData
	Function    *FunctionData
}

func NewText(s string) (Value, error) {
	s, e := coreunicode.NFC(s)
	return Value{Kind: Text, Text: s}, e
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
	return Value{Kind: Map, Entries: out}, nil
}
func NewList(vs []Value) Value { return Value{Kind: List, Items: slices.Clone(vs)} }
func NewBytes(b []byte) Value  { return Value{Kind: Bytes, Bytes: slices.Clone(b)} }
func NewQuantity(n decimal.Number, s string) (Value, error) {
	u, e := ParseUnit(s)
	if e != nil {
		return Value{}, e
	}
	if len(u.Slots) == 0 {
		return Value{Kind: Number, Number: n}, nil
	}
	return Value{Kind: Quantity, Number: n, Unit: u}, nil
}
func NewRange(a, b Value) (Value, error) {
	if a.Kind != b.Kind || a.Kind != Number && a.Kind != Quantity {
		return Value{}, fmt.Errorf("range ends must be numbers or quantities")
	}
	if a.Kind == Quantity && !a.Unit.Compatible(b.Unit) {
		return Value{}, fmt.Errorf("range dimensions differ")
	}
	return Value{Kind: Range, Items: []Value{a, b}}, nil
}
func (v Value) Get(key string) Value {
	key, e := coreunicode.NFC(key)
	if e != nil {
		return Value{}
	}
	for _, p := range v.Entries {
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
		return v.Number.Compare(w.Number) == 0
	case Quantity:
		if !v.Unit.Compatible(w.Unit) {
			return false
		}
		return quantityOrder(v, w) == 0
	case Text, Pattern:
		return v.Text == w.Text
	case Bytes:
		return bytes.Equal(v.Bytes, w.Bytes)
	case List, Range:
		if len(v.Items) != len(w.Items) {
			return false
		}
		for i, a := range v.Items {
			if !a.Equal(w.Items[i]) {
				return false
			}
		}
		return true
	case Map:
		if len(v.Entries) != len(w.Entries) {
			return false
		}
		for _, p := range v.Entries {
			found := false
			for _, q := range w.Entries {
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
		return v.Date == w.Date
	case Instant:
		return v.Seconds == w.Seconds && v.Nanos == w.Nanos
	case Object:
		return v.Object != nil && w.Object != nil && v.Object.Handle == w.Object.Handle
	case Function:
		if v.Function == nil || w.Function == nil || v.Function.Home != w.Function.Home || v.Function.Code != w.Function.Code || v.Function.Group != w.Function.Group {
			return false
		}
		return (Value{Kind: Map, Entries: v.Function.Captures}).Equal(Value{Kind: Map, Entries: w.Function.Captures})
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
		return v.Number.Compare(w.Number), nil
	case Quantity:
		if v.Unit.Compatible(w.Unit) {
			return quantityOrder(v, w), nil
		}
	case Text:
		return strings.Compare(v.Text, w.Text), nil // UTF-8 preserves scalar order.
	case Bytes:
		return bytes.Compare(v.Bytes, w.Bytes), nil
	case Instant:
		if v.Seconds != w.Seconds {
			if v.Seconds < w.Seconds {
				return -1, nil
			}
			return 1, nil
		}
		return cmpInt(int(v.Nanos), int(w.Nanos)), nil
	case CivilDate:
		if v.Date.HasTime == w.Date.HasTime {
			a, b := v.Date, w.Date
			for _, p := range [][2]int{{a.Year, b.Year}, {a.Month, b.Month}, {a.Day, b.Day}, {a.Hour, b.Hour}, {a.Minute, b.Minute}, {a.Second, b.Second}, {a.Nanosecond, b.Nanosecond}} {
				if c := cmpInt(p[0], p[1]); c != 0 {
					return c, nil
				}
			}
			return 0, nil
		}
	case List:
		for i := 0; i < min(len(v.Items), len(w.Items)); i++ {
			if !v.Items[i].Equal(w.Items[i]) {
				return v.Items[i].Compare(w.Items[i])
			}
		}
		return cmpInt(len(v.Items), len(w.Items)), nil
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
