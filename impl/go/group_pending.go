package northtalk

import (
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

type operationCall struct {
	pending bool
}

func hostFailureValue(e *ScriptError) corevalue.Value {
	fields := []corevalue.Pair{}
	if e != nil {
		fields = append(fields, corevalue.Pair{Key: "code", Val: mustText(e.Code)})
		if e.Message != "" {
			fields = append(fields, corevalue.Pair{Key: "message", Val: mustText(e.Message)})
		}
		fields = append(fields, e.Data.inner.Entries()...)
	}
	v, err := corevalue.NewMap(fields)
	if err != nil {
		// Keep the Host input's error field a map; resumption validates the raw failure.
		v, _ = corevalue.NewMap(nil)
	}
	return v
}
