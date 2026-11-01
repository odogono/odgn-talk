package northtalk

import (
	"slices"
	"time"

	"northtalk.org/go/internal/shape"
	corevalue "northtalk.org/go/internal/value"
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

// HTTPFetchImpl makes fetch's requests (chapter 7, Fetching; ADR 0151). The
// Core has checked the request and raised `out of domain` and `invalid
// request`. Fetch hears the normalized URL, with `query` added, and the
// request without `query`: `method` always, `headers` and `body` as given,
// and `json` as its compact JSON text. It answers through the Call with
// {status, headers, body}, which the Core checks, or fails with `bad
// address`, `network error` or `response too large`, and stops the request
// when the Call's Context is done.
type HTTPFetchImpl interface {
	Fetch(c *Call, url string, request Value) error
}

// HTTPCapability defines the optional http server Operations. The binding is
// the Host's own description of the addresses a Grant may listen on; the
// Core never reads it. The embedded Zig Core makes chapter 7's argument and
// answer checks, as for every Standard factory.
func (c *Core) HTTPCapability(impl HTTPImpl, costs Costs) (*CapabilityDef, error) {
	if standardImplementationMissing(impl) {
		return nil, &HostError{InvalidValue, "missing http implementation"}
	}
	return c.HTTPCapabilityWith(impl, nil, costs)
}

// HTTPCapabilityWith defines http with the server Operations, fetch, or
// both: a nil server or client leaves its Operations out, and costs needs an
// entry for each Operation offered. The binding also describes the origins a
// Grant may fetch from.
func (c *Core) HTTPCapabilityWith(server HTTPImpl, client HTTPFetchImpl, costs Costs) (*CapabilityDef, error) {
	serving, fetching := !standardImplementationMissing(server), !standardImplementationMissing(client)
	if !serving && !fetching {
		return nil, &HostError{InvalidValue, "missing http implementation"}
	}
	names := []string{}
	if fetching {
		names = append(names, "fetch")
	}
	if serving {
		names = append(names, "serve", "unserve", "respond")
	}
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
	request := Optional(MapShape(
		Field{Key: "method", Shape: TextShape, Optional: true},
		Field{Key: "headers", Shape: OpenMap(), Optional: true},
		Field{Key: "query", Shape: OpenMap(), Optional: true},
		Field{Key: "body", Shape: OneOf(TextShape, BytesShape), Optional: true},
		Field{Key: "json", Shape: AnyShape, Optional: true},
	))
	fetched := MapShape(Field{Key: "status", Shape: NumberShape}, Field{Key: "headers", Shape: OpenMap()}, Field{Key: "body", Shape: BytesShape})
	// No MaxPending: a fetch waits for the Script's MaxWait.
	fetch := Operation{Name: "fetch", Mode: Suspending, Args: []Shape{TextShape, request}, Result: fetched, Cost: cost["fetch"], Errors: errors("bad address", "network error", "response too large"),
		Start: func(call *Call, args []Value) error {
			raw, _ := args[0].AsText()
			given := Nothing
			if len(args) > 1 {
				given = args[1]
			}
			url, err := fetchURL(raw, given)
			if err != nil {
				return err
			}
			resolved, err := fetchRequest(given)
			if err != nil {
				return err
			}
			return client.Fetch(call, url, resolved)
		},
	}
	impl := server
	all := []Operation{
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
	ops := []Operation{}
	if fetching {
		ops = append(ops, fetch)
	}
	if serving {
		ops = append(ops, all...)
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
