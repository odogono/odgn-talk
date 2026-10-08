package northtalk

import (
	"github.com/odogono/odgn-talk/impl/go/internal/docs"
	"github.com/odogono/odgn-talk/impl/go/internal/machine"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

func init() {
	docs.Function = func(v any) (string, bool) {
		value, ok := v.(Value)
		if !ok || value.inner.Kind != corevalue.Function || value.inner.Function == nil {
			return "", false
		}
		fn := value.inner.Function
		code, ok := fn.CodeState.(*machine.State)
		if !ok || code == nil || code.Unit == nil {
			return "", true
		}
		return code.Unit.Doc(fn.Body), true
	}
	docs.FunctionHead = func(v any) (string, int, int, bool) {
		value, ok := v.(Value)
		if !ok || value.inner.Kind != corevalue.Function || value.inner.Function == nil {
			return "", 0, 0, false
		}
		fn := value.inner.Function
		state, ok := fn.Owner.(*machine.State)
		if code, held := fn.CodeState.(*machine.State); held {
			state, ok = code, true
		}
		if !ok || state == nil || state.Unit == nil || fn.Body < 0 || fn.Body >= len(state.Unit.Bodies) {
			return "", 0, 0, false
		}
		body := state.Unit.Bodies[fn.Body]
		required := 0
		for _, p := range body.Checked.Node.Params {
			if body.Checked.Kind != "function" || len(p.Children) == 0 {
				required++
			}
		}
		return fn.Name, required, len(body.Checked.Node.Params), true
	}
}
