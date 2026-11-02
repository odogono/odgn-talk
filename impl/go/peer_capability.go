package northtalk

import (
	"slices"

	"northtalk.org/go/internal/shape"
	corevalue "northtalk.org/go/internal/value"
)

// PeerImpl holds a Host's exposures and carries its Remote Sends (chapter 7,
// ADRs 0153 to 0155). The embedded Zig Core has checked the Shapes and raised
// `out of domain`, `wrong kind`, `bad message name` and `not encodable`.
// Expose, Reach and Call start suspending calls, answered through the Call:
// Expose and Reach with a Peer made by Group.Object with PeerKind, Call with
// the receiver's reply. Fail Expose with `bad address` or `name in use`,
// Reach with `bad address` or `not exposed`, and Call with `send failed` and
// {reason, error}.
type PeerImpl interface {
	// Expose with name "" makes a new unnamed exposure.
	Expose(c *Call, name string) error
	// Unexpose hears either a name or, for peer non-nil, the Peer.
	Unexpose(c *Call, name string, peer *Object) error
	Reach(c *Call, address string) error
	Post(c *Call, peer *Object, message string, args []Value) error
	Call(c *Call, peer *Object, message string, args []Value) error
	// Caller gives the Caller Identity recorded for c.Delivery, or Nothing
	// (ADR 0154).
	Caller(c *Call) (Value, error)
}

// peerKindName is the Core-fixed Object Kind of a Peer.
const peerKindName = "peer"

// PeerKind is the Core-fixed Object Kind `peer`, with no properties, which a
// Host makes each Peer with.
func (c *Core) PeerKind() *ObjectKind {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.peerKind == nil {
		c.peerKind = &ObjectKind{name: peerKindName, props: map[string]Prop{}}
		// Known to every Group's guest before a Pump, so a Host function
		// can make the first Peer.
		if c.objectKinds == nil {
			c.objectKinds = map[string]*ObjectKind{}
		}
		c.objectKinds[peerKindName] = c.peerKind
	}
	return c.peerKind
}

// PeerCapability defines the optional peer Operations. The binding is the
// Host's own description of the names a Grant may reach and expose; the Core
// never reads it. A send to a Peer is the sending Script's Grant's post, or
// call with `and wait`.
func (c *Core) PeerCapability(impl PeerImpl, costs Costs) (*CapabilityDef, error) {
	if standardImplementationMissing(impl) {
		return nil, &HostError{InvalidValue, "missing peer implementation"}
	}
	// Its kind, declared to each guest before a Host function makes a Peer.
	c.PeerKind()
	names := []string{"call", "caller", "expose", "post", "reach", "unexpose"}
	cost := map[string]Cost{}
	for _, name := range names {
		opCost, err := standardCost(costs, name)
		if err != nil {
			return nil, err
		}
		cost[name] = opCost
	}
	errors := func(codes ...string) []ErrorDecl {
		out := []ErrorDecl{}
		for _, code := range codes {
			out = append(out, ErrorDecl{Code: code})
		}
		return out
	}
	peer := Shape{shape.Shape{Kind: "object", Name: peerKindName}}
	sent := []Shape{peer, TextShape, ListOf(AnyShape)}
	remote := func(args []Value) (*Object, string, []Value) {
		o, _ := args[0].AsObject()
		message, _ := args[1].AsText()
		items := make([]Value, args[2].Len())
		for i := range items {
			items[i] = args[2].Index(i + 1)
		}
		return o, message, items
	}
	ops := []Operation{
		{Name: "call", Mode: Suspending, Args: sent, Result: AnyShape, Cost: cost["call"], Errors: errors("send failed"),
			Start: func(call *Call, args []Value) error {
				o, message, items := remote(args)
				return impl.Call(call, o, message, items)
			},
		},
		{Name: "caller", Mode: Immediate, Args: []Shape{}, Result: AnyShape, Cost: cost["caller"], Errors: errors(),
			Do: func(call *Call, _ []Value) (Value, error) { return impl.Caller(call) },
		},
		{Name: "expose", Mode: Suspending, Args: []Shape{Optional(TextShape)}, Result: peer, Cost: cost["expose"], Errors: errors("bad address", "name in use"),
			Start: func(call *Call, args []Value) error {
				name := ""
				if len(args) > 0 {
					name, _ = args[0].AsText()
				}
				return impl.Expose(call, name)
			},
		},
		{Name: "post", Mode: FireAndForget, Args: sent, Cost: cost["post"], Errors: errors(),
			Fire: func(call *Call, args []Value) error {
				o, message, items := remote(args)
				return impl.Post(call, o, message, items)
			},
		},
		{Name: "reach", Mode: Suspending, Args: []Shape{TextShape}, Result: peer, Cost: cost["reach"], Errors: errors("bad address", "not exposed"),
			Start: func(call *Call, args []Value) error {
				address, _ := args[0].AsText()
				return impl.Reach(call, address)
			},
		},
		{Name: "unexpose", Mode: Immediate, Args: []Shape{OneOf(TextShape, peer)}, Result: NothingShape, Cost: cost["unexpose"], Errors: errors(),
			Do: func(call *Call, args []Value) (Value, error) {
				if o, ok := args[0].AsObject(); ok {
					return Nothing, impl.Unexpose(call, "", o)
				}
				name, _ := args[0].AsText()
				return Nothing, impl.Unexpose(call, name, nil)
			},
		},
	}
	def, err := c.defineCapability("peer", nil, nil, ops...)
	if err != nil {
		return nil, err
	}
	// The embedded Core makes chapter 7's checks; these mark the
	// declaration as the Standard Capability's.
	def.checks = map[string]operationChecks{}
	for _, op := range ops {
		def.checks[op.Name] = operationChecks{failure: func(code string, _ corevalue.Value) bool {
			return slices.ContainsFunc(op.Errors, func(e ErrorDecl) bool { return e.Code == code })
		}}
	}
	return def, nil
}
