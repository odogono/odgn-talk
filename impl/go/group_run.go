package northtalk

import (
	coretrace "github.com/odogono/odgn-talk/impl/go/internal/trace"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

func (r *Unhandled) isReport() {}

func argsDisplay(args []Value) string {
	vs := make([]corevalue.Value, len(args))
	for j, v := range args {
		vs[j] = v.inner
	}
	return coretrace.Display(corevalue.NewList(vs))
}
func sendFailure(reason string, e *ScriptError) *ScriptError {
	fields := []Pair{KV("reason", Value{mustText(reason)})}
	if e != nil {
		vs := []corevalue.Pair{{Key: "code", Val: mustText(e.Code)}, {Key: "message", Val: mustText(e.Message)}}
		for _, p := range e.Data.inner.Entries() {
			vs = append(vs, p)
		}
		errorMap, _ := corevalue.NewMap(vs)
		fields = append(fields, KV("error", Value{errorMap}))
	}
	data, _ := Map(fields...)
	return &ScriptError{Code: "send failed", Data: data}
}
func mustText(s string) corevalue.Value { v, _ := corevalue.NewText(s); return v }
func scriptError(v corevalue.Value) *ScriptError {
	var fields []corevalue.Pair
	for _, p := range v.Entries() {
		if p.Key != "code" && p.Key != "message" {
			fields = append(fields, p)
		}
	}
	data, _ := corevalue.NewMap(fields)
	return &ScriptError{Code: v.Get("code").Text(), Message: v.Get("message").Text(), Data: Value{data}}
}
