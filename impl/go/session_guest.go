package northtalk

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"slices"

	"northtalk.org/go/internal/generated"
	"northtalk.org/go/internal/sessionio"
	corevalue "northtalk.org/go/internal/value"
	"northtalk.org/go/internal/zigwasm"
)

func init() {
	sessionio.OpenGuest = openSessionGuest
	sessionio.DetachedObject = func(kind any, id string, native any) any {
		return &Object{kind: kind.(*ObjectKind), id: id, native: native}
	}
	sessionio.SessionFunction = func(handle string) any {
		return Value{corevalue.Fields{Kind: corevalue.Function, Function: &corevalue.FunctionData{Code: handle, Owner: sessionFunction{}, CodeState: corevalue.WireFunction{Display: "<function>"}}}.Value()}
	}
	sessionio.DecodeInspection = func(ok []byte, object func(kind, id string) (any, bool)) (any, error) {
		src, err := zigParseReply(ok)
		if err != nil {
			return nil, err
		}
		var view generated.EnvelopeInspection
		if err = zigInspectionRecord.decode(src, reflect.ValueOf(&view).Elem()); err != nil {
			return nil, err
		}
		return zigInspection(view, sessionResolver{object})
	}
	sessionio.FunctionHandle = func(raw any) (string, bool) {
		f := raw.(Value).inner.Function()
		if f == nil {
			return "", false
		}
		if _, ok := f.Owner.(sessionFunction); !ok {
			return "", false
		}
		return f.Code, true
	}
}

// sessionResolver reads Values a session's guest wrote: its Host Objects are
// the session's detached ones, and its Function Values hold no Group.
type sessionResolver struct {
	object func(kind, id string) (any, bool)
}

func (r sessionResolver) resolve(kind, id string) (*Object, bool) {
	if r.object == nil {
		return nil, false
	}
	x, ok := r.object(kind, id)
	if !ok {
		return nil, false
	}
	return x.(*Object), true
}

func (sessionResolver) zigFunction(parts []corevalue.Value) (corevalue.Value, error) {
	return zigWireFunction(parts, nil)
}

// sessionFunction marks a Function Value a session's guest exposed, by its
// handle: Go holds it to give back, and never calls it.
type sessionFunction struct{}

// sessionGuest is one reactor serving one session over `session-v1`
// (ADR 0180), with its frames in order.
type sessionGuest struct {
	reactor *zigwasm.Reactor
	ref     int64
}

func openSessionGuest() (*sessionio.Guest, error) {
	ctx := context.Background()
	reactor, err := zigEngine().Instantiate(ctx)
	if err != nil {
		return nil, err
	}
	g := &sessionGuest{reactor: reactor}
	reply, err := g.exchange("hello", map[string]any{"protocol": 1, "features": []string{"session-v1"}}, 0)
	if err == nil {
		var versions struct {
			OK struct {
				Features []string `json:"features"`
			} `json:"ok"`
		}
		if err = json.Unmarshal(reply, &versions); err == nil && !slices.Contains(versions.OK.Features, "session-v1") {
			err = fmt.Errorf("embedded Zig artifact lacks session-v1")
		}
	}
	if err != nil {
		reactor.Close(ctx)
		return nil, err
	}
	return &sessionio.Guest{Exchange: g.exchange, Close: func() { reactor.Close(ctx) }}, nil
}

// exchange sends one frame and returns the whole reply. A ref of 0 takes the
// next; a need's result passes the ref of the frame that asked.
func (g *sessionGuest) exchange(method string, fields map[string]any, ref int64) (json.RawMessage, error) {
	if ref == 0 {
		g.ref++
		ref = g.ref
	}
	frame := map[string]any{"m": method, "ref": ref}
	for k, v := range fields {
		frame[k] = v
	}
	// Source text keeps its original Unicode scalars.
	data, err := zigJSON(nil, frame)
	if err != nil {
		return nil, err
	}
	return g.reactor.Frame(context.Background(), data)
}
