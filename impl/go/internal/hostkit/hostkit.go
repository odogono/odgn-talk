// Package hostkit lets a Host kit runner call a Standard factory's immediate
// Operation as a Script's call would reach it. The hook does not widen the
// public embedding interface.
package hostkit

// Immediate runs def's Operation for the Grant grant in Segment segment of
// group: the factory's argument checks, its Do with a Call that may charge,
// and its check of the Host's failure. group is a *Group, def a
// *CapabilityDef, args and the result are Values.
var Immediate func(group, def any, operation, segment, grant string, binding any, args []any) (any, error)
