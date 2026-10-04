package machine

import (
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

// PropertyFunc belongs to one execution turn. The Group adapter pays the
// instruction and declaration atomically before calling Get or Set, then
// validates and converts a Get result or failure on the same turn.
type PropertyFunc func(object value.Value, name string, set bool, input value.Value, pay func(int64, int64) bool) (value.Value, *value.Value)

type propertyCall struct {
	object, input value.Value
	name          string
	set           bool
	pops          int
}

func propertyRequest(f *Frame, i lower.Instruction) *propertyCall {
	set := i.Name == "set-property" || i.Name == "set-property-computed"
	if !set && i.Name != "get-key" && i.Name != "get-key-computed" {
		return nil
	}
	pops := 1
	if set {
		pops++
	}
	object := f.Stack[len(f.Stack)-pops]
	if object.Kind != value.Object {
		return nil
	}
	computed := i.Name == "get-key-computed" || i.Name == "set-property-computed"
	name := ""
	if computed {
		pops++
		k := f.Stack[len(f.Stack)-pops]
		if k.Kind != value.Text {
			return nil
		} // ordinary instruction raises wrong kind
		name = k.Text
	} else {
		v, _ := constant(i.Operands()[0].Text)
		name = v.Text
	}
	if !set && name == "id" {
		return nil
	} // Core metadata needs no Host crossing
	call := &propertyCall{object: object, name: name, set: set, pops: pops}
	if set {
		call.input = f.Stack[len(f.Stack)-1]
	}
	return call
}

func inGuard(f *Frame) bool {
	for _, u := range f.Code.Unit.Bodies[f.Body].UnwindEntries() {
		if u.Kind == "guard" && f.PC >= u.First && f.PC <= u.Last {
			return true
		}
	}
	return false
}
