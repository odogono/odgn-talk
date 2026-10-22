package northtalk

import (
	"slices"
	"time"

	"github.com/odogono/odgn-talk/impl/go/internal/shape"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// httpMaxPending is how long serve waits, as console's read.
const httpMaxPending = 2147483647 * time.Millisecond

// defaultHTTPMessage is the message serve delivers when none is supplied.
const defaultHTTPMessage = "httpRequest"

// HTTPImpl listens, matches, delivers and answers HTTP Exchanges (chapter 7,
// ADR 0124). The Core has checked the Shapes and raised `invalid serve` and
// `invalid response`. Serve hears the effective message, httpRequest for an
// omitted or Nothing one, and an omitted options as an empty map, and answers
// through the Call with {host, port}. Respond hears the response as the
// Script gave it, except that `json` is its compact JSON text.
type HTTPImpl interface {
	Serve(c *Call, name string, prefix string, message string, options Value) error
	Unserve(c *Call, name string) error
	Respond(c *Call, exchange *Object, response Value) error
}

// HTTPCapability defines the optional http Operations. The binding is the
// Host's own description of the addresses a Grant may listen on; the Core
// never reads it. The embedded Zig Core makes chapter 7's argument and answer
// checks, as for every Standard factory.
func (c *Core) HTTPCapability(impl HTTPImpl, costs Costs) (*CapabilityDef, error) {
	if standardImplementationMissing(impl) {
		return nil, &HostError{InvalidValue, "missing http implementation"}
	}
	cost := map[string]Cost{}
	for _, name := range []string{"serve", "unserve", "respond"} {
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
	exchange := Shape{shape.Shape{Kind: "object", Name: "httpExchange"}}
	response := MapShape(
		Field{Key: "status", Shape: NumberShape, Optional: true},
		Field{Key: "headers", Shape: OpenMap(), Optional: true},
		Field{Key: "body", Shape: OneOf(TextShape, BytesShape), Optional: true},
		Field{Key: "json", Shape: AnyShape, Optional: true},
	)
	options := Optional(MapShape(
		Field{Key: "host", Shape: TextShape, Optional: true},
		Field{Key: "port", Shape: NumberShape, Optional: true},
	))
	address := MapShape(Field{Key: "host", Shape: TextShape}, Field{Key: "port", Shape: NumberShape})
	ops := []Operation{
		{Name: "serve", Mode: Suspending, Args: []Shape{TextShape, TextShape, Optional(TextShape), options}, Result: address, Cost: cost["serve"], Errors: errors("address in use", "bad address"), MaxPending: httpMaxPending,
			Start: func(call *Call, args []Value) error {
				name, _ := args[0].AsText()
				prefix, _ := args[1].AsText()
				message := defaultHTTPMessage
				if len(args) > 2 {
					if m, ok := args[2].AsText(); ok {
						message = m
					}
				}
				given, _ := Map()
				if len(args) > 3 && args[3].Kind() == KindMap {
					given = args[3]
				}
				return impl.Serve(call, name, prefix, message, given)
			},
		},
		{Name: "unserve", Mode: Immediate, Args: []Shape{TextShape}, Result: NothingShape, Cost: cost["unserve"], Errors: errors(),
			Do: func(call *Call, args []Value) (Value, error) {
				name, _ := args[0].AsText()
				return Nothing, impl.Unserve(call, name)
			},
		},
		{Name: "respond", Mode: Immediate, Args: []Shape{exchange, response}, Result: NothingShape, Cost: cost["respond"], Errors: errors("already responded", "exchange closed", "not owner"),
			Do: func(call *Call, args []Value) (Value, error) {
				o, _ := args[0].AsObject()
				resolved, err := httpResponse(args[1])
				if err != nil {
					return Nothing, err
				}
				return Nothing, impl.Respond(call, o, resolved)
			},
		},
	}
	def, err := c.defineCapability("http", nil, nil, ops...)
	if err != nil {
		return nil, err
	}
	def.checks = map[string]operationChecks{}
	for _, op := range ops {
		def.checks[op.Name] = operationChecks{failure: func(code string, _ corevalue.Value) bool {
			return slices.ContainsFunc(op.Errors, func(e ErrorDecl) bool { return e.Code == code })
		}}
	}
	return def, nil
}

// httpResponse is the response respond hears: `json` as its JSON text.
func httpResponse(response Value) (Value, error) {
	entries := response.Entries()
	if !slices.ContainsFunc(entries, func(p Pair) bool { return p.Key == "json" }) {
		return response, nil
	}
	for i, p := range entries {
		if p.Key != "json" {
			continue
		}
		written, err := EncodeJSON(p.Val)
		if err != nil {
			return Nothing, err
		}
		if entries[i].Val, err = Text(string(written)); err != nil {
			return Nothing, err
		}
	}
	return Map(entries...)
}
