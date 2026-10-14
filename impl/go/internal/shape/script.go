// Script Shape checks (chapter 7): Shapes as data, decoded and checked
// iteratively so depth is bounded by the budgets, not the call stack. The
// scanned count is what the Built-in rates measure, failed work included.
package shape

import (
	"unicode/utf8"

	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

// A DefinitionError is the first reason data isn't a Shape.
type DefinitionError struct {
	Reason string
	Path   []value.Value
	Value  value.Value
}

// A Diagnostic is a Mismatch, with a failed union's grouped alternatives.
type Diagnostic struct {
	Mismatch
	Alternatives [][]Diagnostic
}

var scalarKinds = map[string]bool{
	"nothing": true, "boolean": true, "number": true, "quantity": true,
	"text": true, "bytes": true, "list": true, "map": true, "range": true,
	"instant": true, "civil date": true, "pattern": true, "function": true,
	"object": true,
}
var wrapperKeys = []string{"quantity", "unitKind", "object", "list", "oneOf", "optional", "map"}

func scalars(s string) int64 { return int64(utf8.RuneCountInString(s)) }

func lookup(entries []value.Pair, key string) (value.Value, bool) {
	for _, p := range entries {
		if p.Key == key {
			return p.Val, true
		}
	}
	return value.Value{}, false
}

func pathInt(i int) value.Value {
	return value.Fields{Kind: value.Number, Number: decimal.FromInt(int64(i))}.Value()
}
func positionKey(i int) value.Value { return pathInt(i) }

type decodeFrame struct {
	kind     string // enter, wrap, oneOf, mapDone, field, fieldDone
	data     value.Value
	path     []value.Value
	wrap     string
	n        int
	acc      *[]Field
	seen     map[string]bool
	open     bool
	key      string
	optional bool
}

// Decode reads Shape data into a Shape, or gives the first definition error.
func Decode(data value.Value) (Shape, *DefinitionError, int64) {
	var scanned int64
	var results []Shape
	stack := []decodeFrame{{kind: "enter", data: data}}
	fail := func(reason string, path []value.Value, v value.Value) (Shape, *DefinitionError, int64) {
		return Shape{}, &DefinitionError{Reason: reason, Path: path, Value: v}, scanned
	}
	for len(stack) > 0 {
		frame := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		switch frame.kind {
		case "wrap":
			inner := results[len(results)-1]
			results = results[:len(results)-1]
			results = append(results, Shape{Kind: frame.wrap, Of: []Shape{inner}})
		case "oneOf":
			of := make([]Shape, frame.n)
			copy(of, results[len(results)-frame.n:])
			results = results[:len(results)-frame.n]
			results = append(results, Shape{Kind: "oneOf", Of: of})
		case "mapDone":
			results = append(results, Shape{Kind: "map", Fields: *frame.acc, Open: frame.open})
		case "fieldDone":
			inner := results[len(results)-1]
			results = results[:len(results)-1]
			*frame.acc = append(*frame.acc, Field{Key: frame.key, Shape: inner, Optional: frame.optional})
		case "field":
			decl, path := frame.data, frame.path
			if decl.Kind != value.Map {
				return fail("invalid field", path, decl)
			}
			entries := decl.Entries()
			scanned += int64(len(entries))
			key, ok := lookup(entries, "key")
			if !ok {
				return fail("invalid field key", path, decl)
			}
			if key.Kind != value.Text {
				return fail("invalid field key", child(path, pathKey("key")), key)
			}
			inner, ok := lookup(entries, "shape")
			if !ok {
				return fail("missing field shape", path, decl)
			}
			flag, hasFlag := lookup(entries, "optional")
			if hasFlag && flag.Kind != value.Boolean {
				return fail("invalid flag", child(path, pathKey("optional")), flag)
			}
			name := key.Text()
			if frame.seen[name] {
				return fail("duplicate field", child(path, pathKey("key")), key)
			}
			frame.seen[name] = true
			stack = append(stack, decodeFrame{kind: "fieldDone", acc: frame.acc, key: name, optional: hasFlag && flag.Bool})
			stack = append(stack, decodeFrame{kind: "enter", data: inner, path: child(path, pathKey("shape"))})
		case "enter":
			node, path := frame.data, frame.path
			scanned++
			if node.Kind == value.Text {
				name := node.Text()
				scanned += scalars(name)
				switch {
				case name == "any" || name == "value":
					results = append(results, Shape{Kind: name})
				case scalarKinds[name]:
					results = append(results, Shape{Kind: "kind", Name: name})
				default:
					return fail("unknown kind", path, node)
				}
				continue
			}
			if node.Kind != value.Map {
				return fail("not a shape", path, node)
			}
			entries := node.Entries()
			scanned += int64(len(entries))
			var present []string
			for _, k := range wrapperKeys {
				if _, ok := lookup(entries, k); ok {
					present = append(present, k)
				}
			}
			if len(present) == 0 {
				return fail("not a shape", path, node)
			}
			if len(present) > 1 {
				return fail("ambiguous shape", path, node)
			}
			key := present[0]
			payload, _ := lookup(entries, key)
			switch key {
			case "quantity":
				if payload.Kind != value.Text {
					return fail("invalid unit", child(path, pathKey(key)), payload)
				}
				scanned += scalars(payload.Text())
				unit, e := value.ParseUnit(payload.Text())
				if e != nil {
					return fail("invalid unit", child(path, pathKey(key)), payload)
				}
				results = append(results, Shape{Kind: "quantity", Name: unit.String()})
			case "unitKind":
				if payload.Kind == value.Text {
					scanned += scalars(payload.Text())
				}
				known := false
				if payload.Kind == value.Text {
					for _, k := range generated.Units.Kind {
						if k.Name == payload.Text() {
							known = true
						}
					}
				}
				if !known {
					return fail("unknown unit kind", child(path, pathKey(key)), payload)
				}
				results = append(results, Shape{Kind: "unitKind", Name: payload.Text()})
			case "object":
				if payload.Kind != value.Text {
					return fail("invalid object kind", child(path, pathKey(key)), payload)
				}
				results = append(results, Shape{Kind: "object", Name: payload.Text()})
			case "list", "optional":
				stack = append(stack, decodeFrame{kind: "wrap", wrap: key})
				stack = append(stack, decodeFrame{kind: "enter", data: payload, path: child(path, pathKey(key))})
			case "oneOf":
				if payload.Kind != value.List {
					return fail("invalid alternatives", child(path, pathKey(key)), payload)
				}
				items := payload.Items()
				if len(items) == 0 {
					return fail("empty union", child(path, pathKey(key)), payload)
				}
				stack = append(stack, decodeFrame{kind: "oneOf", n: len(items)})
				for i := len(items); i >= 1; i-- {
					p := child(path, pathKey(key))
					stack = append(stack, decodeFrame{kind: "enter", data: items[i-1], path: child(p, positionKey(i))})
				}
			case "map":
				flag, hasFlag := lookup(entries, "open")
				if hasFlag && flag.Kind != value.Boolean {
					return fail("invalid flag", child(path, pathKey("open")), flag)
				}
				if payload.Kind != value.List {
					return fail("invalid fields", child(path, pathKey(key)), payload)
				}
				acc := &[]Field{}
				seen := map[string]bool{}
				stack = append(stack, decodeFrame{kind: "mapDone", acc: acc, open: hasFlag && flag.Bool})
				items := payload.Items()
				for i := len(items); i >= 1; i-- {
					p := child(path, pathKey(key))
					stack = append(stack, decodeFrame{kind: "field", data: items[i-1], path: child(p, positionKey(i)), acc: acc, seen: seen})
				}
			}
		}
	}
	return results[0], nil, scanned
}

type sink struct{ diags []Diagnostic }

type checkFrame struct {
	kind      string // node, deep, extras, missing, adjust, union
	v         value.Value
	s         Shape
	path      []value.Value
	out       *sink
	trial     int
	expected  string
	mark      int
	alts      []Shape
	index     int
	current   *sink
	collected [][]Diagnostic
}

// Diagnostics gives every mismatch of v against s, or only the first.
func Diagnostics(v value.Value, s Shape, first bool, scanned int64) ([]Diagnostic, int64) {
	root := &sink{}
	discarded := map[int]bool{}
	trials := 0
	halted := false
	// A deep scan charges a shared part's logical nodes without
	// re-walking it once it is known to hold no Function Value (#890).
	deepScans := map[any]value.DeepScan{}
	stack := []checkFrame{{kind: "node", v: v, s: s, out: root}}
	emit := func(out *sink, trial int, d Diagnostic) {
		out.diags = append(out.diags, d)
		if !first {
			return
		}
		if trial == 0 {
			// Only enclosing Optional adjustments may still run.
			halted = true
			kept := stack[:0]
			for _, f := range stack {
				if f.kind == "adjust" {
					kept = append(kept, f)
				}
			}
			stack = kept
			return
		}
		discarded[trial] = true
		kept := stack[:0]
		for _, f := range stack {
			if f.trial != trial {
				kept = append(kept, f)
			}
		}
		stack = kept
	}
	wrong := func(out *sink, trial int, val value.Value, shape Shape, path []value.Value) {
		got := value.KindNames[val.Kind]
		if (shape.Kind == "quantity" || shape.Kind == "unitKind") && val.Kind == value.Quantity {
			got = val.Unit().String()
		}
		emit(out, trial, Diagnostic{Mismatch: Mismatch{Expected: shape.Expected(), Got: got, Value: val, Path: path}})
	}
	samePath := func(a, b []value.Value) bool {
		if len(a) != len(b) {
			return false
		}
		for i := range a {
			if !a[i].Equal(b[i]) {
				return false
			}
		}
		return true
	}
	for len(stack) > 0 {
		frame := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if discarded[frame.trial] {
			continue
		}
		switch frame.kind {
		case "adjust":
			for i := frame.mark; i < len(frame.out.diags); i++ {
				d := &frame.out.diags[i]
				if !d.Unencodable && samePath(d.Path, frame.path) {
					d.Expected += " or nothing"
					break
				}
			}
		case "missing":
			scanned++
			emit(frame.out, frame.trial, Diagnostic{Mismatch: Mismatch{Expected: frame.expected, Got: "nothing", Path: frame.path}})
		case "deep":
			if scan := value.DeepScanOf(frame.v, deepScans); scan.Clean {
				scanned += scan.Nodes
				continue
			}
			scanned++
			val := frame.v
			if val.Kind == value.Function {
				emit(frame.out, frame.trial, Diagnostic{Mismatch: Mismatch{Expected: "any", Got: "function", Value: val, Path: frame.path, Unencodable: true}})
			} else if val.Kind == value.List {
				items := val.Items()
				for i := len(items); i >= 1; i-- {
					stack = append(stack, checkFrame{kind: "deep", v: items[i-1], path: child(frame.path, pathInt(i)), out: frame.out, trial: frame.trial})
				}
			} else if val.Kind == value.Map {
				entries := val.Entries()
				for i := len(entries) - 1; i >= 0; i-- {
					stack = append(stack, checkFrame{kind: "deep", v: entries[i].Val, path: child(frame.path, pathKey(entries[i].Key)), out: frame.out, trial: frame.trial})
				}
			}
		case "extras":
			declared := map[string]bool{}
			for _, f := range frame.s.Fields {
				declared[f.Key] = true
			}
			var deeps []checkFrame
			for _, p := range frame.v.Entries() {
				if declared[p.Key] {
					continue
				}
				if !frame.s.Open {
					scanned++
					emit(frame.out, frame.trial, Diagnostic{Mismatch: Mismatch{Expected: "nothing", Got: value.KindNames[p.Val.Kind], Value: p.Val, Path: child(frame.path, pathKey(p.Key))}})
					if halted || discarded[frame.trial] {
						break
					}
				} else {
					deeps = append(deeps, checkFrame{kind: "deep", v: p.Val, path: child(frame.path, pathKey(p.Key)), out: frame.out, trial: frame.trial})
				}
			}
			for i := len(deeps) - 1; i >= 0; i-- {
				stack = append(stack, deeps[i])
			}
		case "union":
			if frame.current != nil {
				if len(frame.current.diags) == 0 {
					continue
				}
				frame.collected = append(frame.collected, frame.current.diags)
				frame.current = nil
				frame.index++
			}
			if frame.index >= len(frame.alts) {
				got := value.KindNames[frame.v.Kind]
				emit(frame.out, frame.trial, Diagnostic{
					Mismatch:     Mismatch{Expected: frame.s.Expected(), Got: got, Value: frame.v, Path: frame.path},
					Alternatives: frame.collected,
				})
				continue
			}
			current := &sink{}
			frame.current = current
			trials++
			stack = append(stack, frame)
			stack = append(stack, checkFrame{kind: "node", v: frame.v, s: frame.alts[frame.index], path: frame.path, out: current, trial: trials})
		case "node":
			scanned++
			val, shape, path := frame.v, frame.s, frame.path
			switch shape.Kind {
			case "value":
			case "any":
				stack = append(stack, checkFrame{kind: "deep", v: val, path: path, out: frame.out, trial: frame.trial})
			case "kind":
				if value.KindNames[val.Kind] != shape.Name {
					wrong(frame.out, frame.trial, val, shape, path)
				}
			case "object":
				if val.Kind != value.Object || val.Object().Kind != shape.Name {
					wrong(frame.out, frame.trial, val, shape, path)
				}
			case "quantity":
				if val.Kind != value.Quantity || val.Unit().String() != shape.Name {
					wrong(frame.out, frame.trial, val, shape, path)
				}
			case "unitKind":
				ok := val.Kind == value.Quantity && len(val.Unit().Slots) == 1 && val.Unit().Slots[0].Power.String() == "1" && generated.Units.Unit[val.Unit().Slots[0].Unit].Kind == shape.Name
				if !ok {
					wrong(frame.out, frame.trial, val, shape, path)
				}
			case "list":
				if val.Kind != value.List {
					wrong(frame.out, frame.trial, val, shape, path)
					break
				}
				items := val.Items()
				for i := len(items); i >= 1; i-- {
					stack = append(stack, checkFrame{kind: "node", v: items[i-1], s: shape.Of[0], path: child(path, pathInt(i)), out: frame.out, trial: frame.trial})
				}
			case "map":
				if val.Kind != value.Map {
					wrong(frame.out, frame.trial, val, shape, path)
					break
				}
				stack = append(stack, checkFrame{kind: "extras", v: val, s: shape, path: path, out: frame.out, trial: frame.trial})
				for i := len(shape.Fields) - 1; i >= 0; i-- {
					f := shape.Fields[i]
					if item, ok := lookup(val.Entries(), f.Key); ok {
						stack = append(stack, checkFrame{kind: "node", v: item, s: f.Shape, path: child(path, pathKey(f.Key)), out: frame.out, trial: frame.trial})
					} else if !f.Optional {
						stack = append(stack, checkFrame{kind: "missing", expected: f.Shape.Expected(), path: child(path, pathKey(f.Key)), out: frame.out, trial: frame.trial})
					}
				}
			case "oneOf":
				stack = append(stack, checkFrame{kind: "union", v: val, s: shape, alts: shape.Of, path: path, out: frame.out, trial: frame.trial})
			case "optional":
				if val.Kind == value.Nothing {
					break
				}
				stack = append(stack, checkFrame{kind: "adjust", mark: len(frame.out.diags), path: path, out: frame.out, trial: frame.trial})
				stack = append(stack, checkFrame{kind: "node", v: val, s: shape.Of[0], path: path, out: frame.out, trial: frame.trial})
			}
		}
	}
	return root.diags, scanned
}

// Record builds one explain record: the error's fields as a plain map.
func Record(d Diagnostic) value.Value {
	text := func(s string) value.Value { v, _ := value.NewText(s); return v }
	if d.Unencodable {
		v, _ := value.NewMap([]value.Pair{
			{Key: "code", Val: text("not encodable")},
			{Key: "kind", Val: text(d.Got)},
			{Key: "path", Val: value.NewList(d.Path)},
		})
		return v
	}
	fields := []value.Pair{
		{Key: "code", Val: text("wrong kind")},
		{Key: "expected", Val: text(d.Expected)},
		{Key: "got", Val: text(d.Got)},
		{Key: "value", Val: d.Value},
	}
	if len(d.Path) > 0 {
		fields = append(fields, value.Pair{Key: "path", Val: value.NewList(d.Path)})
	}
	if d.Alternatives != nil {
		alts := make([]value.Value, len(d.Alternatives))
		for i, alt := range d.Alternatives {
			records := make([]value.Value, len(alt))
			for j, sub := range alt {
				records[j] = Record(sub)
			}
			alts[i] = value.NewList(records)
		}
		fields = append(fields, value.Pair{Key: "alternatives", Val: value.NewList(alts)})
	}
	v, _ := value.NewMap(fields)
	return v
}
