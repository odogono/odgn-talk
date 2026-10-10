// Package messagehooks gives the Message Layer what an `op` request carries
// that the public embedding interface doesn't expose.
package messagehooks

// FuelLeft returns the Fuel a starting Call may still charge; ok is false
// when the Run has no Fuel limit or the Call isn't starting. call is a *Call.
var FuelLeft func(call any) (fuel int64, ok bool)
