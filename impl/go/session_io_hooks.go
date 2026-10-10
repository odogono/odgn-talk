package northtalk

import (
	"encoding/json"
	"fmt"
	"github.com/odogono/odgn-talk/impl/go/internal/sessionio"
	v "github.com/odogono/odgn-talk/impl/go/internal/value"
)

func init() {
	sessionio.FunctionIdentity = func(raw any) any { return raw.(Value).inner.Function() }
	sessionio.Shape = func(raw any) any {
		b, err := json.Marshal(shapeData(raw.(Shape).inner))
		if err != nil {
			panic(err)
		}
		return json.RawMessage(b)
	}
	sessionio.ObjectShape = func(name string) any { return ObjectShape(&ObjectKind{name: name}) }
	sessionio.Attach = func(group any, expose func(any)) { group.(*Group).sessionExpose = expose }
	sessionio.Decode = func(bytes []byte, object func(string, string) (any, bool), function func(string) (any, bool)) (any, error) {
		x, err := v.DecodeWithFunctions(bytes, true, func(kind, id string) (v.Value, error) {
			raw, ok := object(kind, id)
			if !ok {
				return v.Value{}, fmt.Errorf("unknown object")
			}
			return raw.(*Object).Value().inner, nil
		}, func(h string) (v.Value, error) {
			raw, ok := function(h)
			if !ok {
				return v.Value{}, fmt.Errorf("unresolved function")
			}
			return raw.(Value).inner, nil
		})
		return Value{x}, err
	}
	sessionio.Reply = func(raw any, id string, value any, failure any, fuel int64) {
		g := raw.(*Group)
		c := &Call{group: g, id: CallID(id)}
		if failure != nil {
			c.Fail(failure.(*ScriptError))
		} else {
			c.AnswerWithCost(value.(Value), fuel)
		}
	}
	sessionio.CancelDelivery = func(raw any, id string) {
		g := raw.(*Group)
		g.mu.Lock()
		g.inputs = append(g.inputs, delivery{cancel: DeliveryID(id)})
		ready := g.options.OnReady
		g.mu.Unlock()
		if ready != nil {
			ready()
		}
	}
}
