package corpus

import (
	"fmt"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

// replayValues binds display forms to actual public API handles. Trace text
// never supplies handles; a Function must have crossed to this Host first.
// Each receipt replaces the previous handle with that display, even after
// Reload. The Group remains responsible for ownership and staleness checks.
type replayValues struct {
	functions map[string]talk.Value
	objects   objectReplay
}

func newReplayValues() *replayValues {
	return &replayValues{functions: map[string]talk.Value{}}
}

func (r *replayValues) receive(v talk.Value) {
	switch v.Kind() {
	case talk.KindFunction:
		r.functions[v.String()] = v
	case talk.KindList:
		for i := 1; i <= v.Len(); i++ {
			r.receive(v.Index(i))
		}
	case talk.KindMap:
		for _, entry := range v.Entries() {
			r.receive(entry.Val)
		}
	}
}

func (r *replayValues) construct(v value.Value) (talk.Value, error) {
	return constructWith(v, func(v value.Value) (talk.Value, error) {
		switch v.Kind {
		case value.Function:
			if fn, ok := r.functions[v.Display()]; ok {
				return fn, nil
			}
		case value.Object:
			if v.Object != nil {
				if object := r.objects[objectRef{v.Object.Kind, v.Object.ID}]; object != nil {
					return object.Value(), nil
				}
			}
		}
		return talk.Nothing, fmt.Errorf("unknown replay handle %s", v.Display())
	})
}

func (r *replayValues) hasReceivedFunction(v value.Value) bool {
	if v.Kind == value.Function {
		_, received := r.functions[v.Display()]
		return received
	}
	for _, item := range v.Items {
		if r.hasReceivedFunction(item) {
			return true
		}
	}
	for _, pair := range v.Entries {
		if r.hasReceivedFunction(pair.Val) {
			return true
		}
	}
	return false
}
