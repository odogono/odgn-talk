package machine

import (
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
	"slices"
)

func functionArity(body *lower.Body) (required, total int) {
	for _, param := range body.Checked.Node.Params {
		if body.Checked.Kind != "function" || len(param.Children) == 0 {
			required++
		}
	}
	return required, len(body.Checked.Node.Params)
}

func functionArguments(fn value.Value, args []value.Value) (*State, []value.Value, *value.Value) {
	data := fn.Function
	code := data.Owner.(*State)
	if unit, ok := data.CodeState.(*State); ok {
		code = unit
	}
	body := code.Unit.Bodies[data.Body]
	required, total := functionArity(body)
	if len(args) < required || len(args) > total {
		e := failure("wrong arity")
		return code, nil, &e
	}
	bound := slices.Clone(args)
	for j := len(bound); j < len(body.Checked.Node.Params); j++ {
		slot := slices.Index(code.Unit.Definitions, body.Checked.Name+"."+body.Checked.Node.Params[j].Text)
		bound = append(bound, BindLibraryValue(code.Definitions[slot], data.Owner.(*State)))
	}
	return code, bound, nil
}
func (r *Run) pushFunction(code *State, fn value.Value, args []value.Value) {
	r.pushCodeFrame(code, fn.Function.Body, args)
	body := code.Unit.Bodies[fn.Function.Body]
	frame := &r.Frames[len(r.Frames)-1]
	for _, capture := range fn.Function.Captures {
		frame.Locals[body.Checked.Slot(capture.Key)] = capture.Val
	}
}

// StartFunction has no Handler Clause dispatch. Host arity errors belong to
// the new Run at the body's first instruction, with no charge or unwind.
func StartFunction(s *State, fn value.Value, args []value.Value, limits Limits) *Run {
	r := &Run{State: s, Limits: limits, Base: slices.Clone(s.Variables)}
	code, bound, err := functionArguments(fn, args)
	r.pushFunction(code, fn, bound)
	if err != nil {
		body := code.Unit.Bodies[fn.Function.Body]
		r.At = body.Code[0]
		r.PC = body.First
		r.Raises = append(r.Raises, Raised{Unit: codeName(code, fn.Function.Body), Handler: enclosingHandler(body.Checked), Code: "wrong arity", Instruction: r.At, PC: r.PC})
		pos := r.At.Pos
		at, _ := value.NewMap([]value.Pair{{Key: "unit", Val: text(codeName(code, fn.Function.Body))}, {Key: "handler", Val: text(enclosingHandler(body.Checked))}, {Key: "line", Val: integer(int64(pos.Line))}, {Key: "column", Val: integer(int64(pos.Column))}})
		r.Error, _ = value.NewMap(append(slices.Clone(err.Entries), value.Pair{Key: "at", Val: at}))
		r.Error.CoreMessage = true
		r.Status = Errored
		r.setFrames(nil)
	}
	return r
}
