// Package sessionio connects the ordinary Session adapter to private message-layer inputs.
package sessionio

// FunctionIdentity preserves the identity of a Value supplied at a crossing,
// including when two independently exposed Functions compare equal.
var FunctionIdentity func(any) any

var Attach func(group any, expose func(any))
var Decode func(bytes []byte, object func(string, string) (any, bool), function func(string) (any, bool)) (any, error)
var Reply func(group any, id string, value any, failure any, fuel int64)
var CancelDelivery func(group any, id string)
var ObjectShape func(name string) any
var Shape func(shape any) any
