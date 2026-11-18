// Package sessionio connects the session package to the root package's
// private Value and guest plumbing.
package sessionio

import "encoding/json"

var Decode func(bytes []byte, object func(string, string) (any, bool), function func(string) (any, bool)) (any, error)
var ObjectShape func(name string) any
var Shape func(shape any) any

// Guest is a reactor serving one session over `session-v1` (ADR 0180).
// Exchange sends one frame and returns its whole reply: a ref of 0 takes the
// next, and a need's result passes the ref of the frame that asked.
type Guest struct {
	Exchange func(method string, fields map[string]any, ref int64) (json.RawMessage, error)
	Close    func()
}

// OpenGuest starts a guest that has negotiated `session-v1`.
var OpenGuest func() (*Guest, error)

// DetachedObject makes a Host Object a session's guest holds, whose
// callbacks Go answers through `prop` needs.
var DetachedObject func(kind any, id string, native any) any

// SessionFunction is the Function Value a session exposed under handle;
// FunctionHandle gives back the handle of one.
var SessionFunction func(handle string) any
var FunctionHandle func(value any) (string, bool)

// DecodeInspection reads `session-inspect`'s `ok` as a talk.Inspection,
// resolving Host Objects through object.
var DecodeInspection func(ok []byte, object func(kind, id string) (any, bool)) (any, error)
