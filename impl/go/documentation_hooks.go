package northtalk

import (
	"northtalk.org/go/internal/docs"
	corevalue "northtalk.org/go/internal/value"
)

func init() {
	docs.FunctionUnit = func(v any) ([32]byte, bool) {
		value, ok := v.(Value)
		if !ok || value.inner.Function() == nil {
			return [32]byte{}, false
		}
		wire, ok := value.inner.Function().CodeState.(corevalue.WireFunction)
		return wire.Unit, ok && wire.HasUnit
	}
	docs.Function = func(v any) (string, bool) {
		value, ok := v.(Value)
		if !ok || value.inner.Kind != corevalue.Function || value.inner.Function() == nil {
			return "", false
		}
		// A Function the guest carries no defining unit for, a Lambda's
		// among them, has no Declaration Documentation.
		return "", true
	}
	docs.FunctionHead = func(v any) (string, int, int, bool) {
		value, ok := v.(Value)
		if !ok || value.inner.Kind != corevalue.Function || value.inner.Function() == nil {
			return "", 0, 0, false
		}
		fn := value.inner.Function()
		return fn.Name, fn.Required, fn.Total, true
	}
}
