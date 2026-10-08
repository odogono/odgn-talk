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
}
