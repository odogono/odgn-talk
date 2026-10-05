// Package replay exposes message-layer inputs to the conformance runner. These
// hooks do not widen the public embedding interface or serialize Host futures.
package replay

type Object struct {
	Kind, ID string
	Handle   any
}

var Objects func(group any) []Object

var Libraries func(group any) []any

// Pending returns in-flight Capability call ids at a quiescent boundary.
var Pending func(group any) []string
