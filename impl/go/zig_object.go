//go:build talk_zig_experimental

package northtalk

import (
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"sort"
	"unicode/utf8"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/shape"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// Object Kinds are mirrored into each guest by name the first time one of
// their handles is made. Handles, natives and property callbacks stay in Go;
// the guest sees only {"$object": [kind, id]}.
func (b *zigGroup) defineKind(kind *ObjectKind) error {
	b.reg.kindsMu.Lock()
	if known, ok := b.reg.kinds[kind.name]; ok && known != kind {
		b.reg.kindsMu.Unlock()
		// A Group with nothing but its name can move to a guest where
		// the name is free, as a guest of its own would have been.
		if b.moveForKind(kind) {
			return b.defineKind(kind)
		}
		return backendUnsupported("two Object Kinds with one name in a Group's guest")
	}
	defer b.reg.kindsMu.Unlock()
	if _, ok := b.reg.kinds[kind.name]; ok {
		return nil
	}
	names := make([]string, 0, len(kind.props))
	for name := range kind.props {
		names = append(names, name)
	}
	sort.Strings(names)
	props := make([]any, len(names))
	for i, name := range names {
		prop := kind.props[name]
		shape, err := zigShape(prop.Shape.inner, 0)
		if err != nil {
			return err
		}
		props[i] = map[string]any{"name": name, "shape": shape, "readOnly": prop.Set == nil, "getCost": map[string]any{"fuel": prop.GetCost.Fuel, "alloc": prop.GetCost.Alloc}, "setCost": map[string]any{"fuel": prop.SetCost.Fuel, "alloc": prop.SetCost.Alloc}}
	}
	parents := make([]any, len(kind.parentKinds))
	for i, k := range kind.parentKinds {
		parents[i] = k
	}
	// A Core-level declaration cannot be sent while a worker waits for its
	// result; a kind first used inside a Host callback is refused.
	b.frameMu.Lock()
	paused := b.paused
	b.frameMu.Unlock()
	if paused {
		return backendUnsupported("declaring an Object Kind during a Host callback")
	}
	if _, err := b.send("define-object-kind", map[string]any{"name": kind.name, "props": props, "parentKinds": parents}); err != nil {
		return err
	}
	b.reg.kinds[kind.name] = kind
	return nil
}

// syncKinds declares every Kind the Core knows before a worker call, so a
// Host callback can make the first handle of a Kind defined earlier.
func (b *zigGroup) syncKinds() error {
	c := b.group.core
	c.mu.Lock()
	kinds := make([]*ObjectKind, 0, len(c.objectKinds))
	for _, k := range c.objectKinds {
		kinds = append(kinds, k)
	}
	c.mu.Unlock()
	sort.Slice(kinds, func(i, j int) bool { return kinds[i].name < kinds[j].name })
	for _, k := range kinds {
		b.reg.kindsMu.Lock()
		_, known := b.reg.kinds[k.name]
		b.reg.kindsMu.Unlock()
		if known {
			continue
		}
		if err := b.defineKind(k); err != nil {
			return err
		}
	}
	return nil
}

func (b *zigGroup) object(kind *ObjectKind, id string) error {
	if err := b.defineKind(kind); err != nil {
		return err
	}
	_, err := b.send("object", map[string]any{"kind": kind.name, "id": id})
	return err
}

func zigObject(o *Object) map[string]any {
	return map[string]any{"$object": []any{o.kind.name, o.id}}
}

func (b *zigGroup) setParent(o, parent *Object) error {
	fields := map[string]any{"object": zigObject(o), "parent": nil}
	if parent != nil {
		fields["parent"] = zigObject(parent)
	}
	if _, err := b.send("set-parent", fields); err != nil {
		return err
	}
	b.ready()
	return nil
}

func (b *zigGroup) dispose(o *Object) error {
	if _, err := b.send("dispose", map[string]any{"object": zigObject(o)}); err != nil {
		return err
	}
	b.ready()
	return nil
}

// resolve gives the registered handle for a decoded Value Encoding.
func (b *zigGroup) resolve(kind, id string) (*Object, bool) {
	return b.group.ObjectByID(kind, id)
}

// A property crossing runs the public Get or Set with the Host's own handle.
// The guest has already charged, checked read-only and Set's Shape; it
// checks Get's result Shape after the reply.
func (b *zigGroup) property(need Value) (map[string]any, error) {
	ref := need.Get("object").Get("$object")
	o, ok := b.resolve(zigText(ref.Index(1)), zigText(ref.Index(2)))
	if !ok {
		return nil, fmt.Errorf("Zig property names an unknown Object")
	}
	prop, ok := o.kind.props[zigText(need.Get("prop"))]
	if !ok {
		return nil, fmt.Errorf("Zig property names an undeclared property")
	}
	set := false
	for _, entry := range need.Entries() {
		set = set || entry.Key == "value"
	}
	var input Value
	if set {
		if err := b.decode(need.Get("value"), reflect.ValueOf(&input).Elem()); err != nil {
			return nil, err
		}
	}
	result, failure := invokeProperty(prop, o, set, input)
	// Host-only detail for the `call failed` report the guest may make; a
	// property crossing has no Call id, so details are matched in order.
	hostError := func(detail string) (map[string]any, error) {
		b.propertyDetails = append(b.propertyDetails, detail)
		return map[string]any{"hostError": detail}, nil
	}
	switch {
	case failure != nil:
		if e, ok := failure.(*ScriptError); ok && e != nil {
			encoded, err := b.zigScriptFailure(e)
			if err != nil {
				return hostError(err.Error())
			}
			if detail := propertyFailureDetail(e); detail != "" {
				b.propertyDetails = append(b.propertyDetails, detail)
			}
			return map[string]any{"fail": encoded}, nil
		}
		return hostError(fmt.Sprint(failure))
	case set:
		return map[string]any{"ok": true}, nil
	default:
		encoded, err := b.zigEncoded(result)
		if err != nil {
			return hostError(err.Error())
		}
		if shape.Check(result.inner, prop.Shape.inner, nil) != nil {
			b.propertyDetails = append(b.propertyDetails, "result violates its Shape or Group ownership")
		}
		return map[string]any{"value": encoded}, nil
	}
}

// propertyFailureDetail is native Go's reason, if any, that a property's
// well-encoded failure becomes `host error` with a `call failed` report.
func propertyFailureDetail(e *ScriptError) string {
	data := e.Data.inner
	if data.Kind != corevalue.Map && data.Kind != corevalue.Nothing {
		return "failure Data is neither a map nor Nothing"
	}
	failed := []corevalue.Pair{{Key: "code", Val: mustText(e.Code)}}
	if e.Message != "" {
		failed = append(failed, corevalue.Pair{Key: "message", Val: mustText(e.Message)})
	}
	if data.Kind == corevalue.Map {
		failed = append(failed, data.Entries()...)
	}
	if _, err := corevalue.NewMap(failed); err != nil {
		return "failure uses a reserved Data key"
	}
	for _, d := range generated.Errors.Error {
		if d.Code == e.Code {
			return "failure uses a catalogue code"
		}
	}
	if data.Kind == corevalue.Map {
		for _, p := range data.Entries() {
			if slices.Contains(generated.Errors.Reserved, p.Key) {
				return "failure uses a reserved Data key"
			}
		}
	}
	return ""
}

// zigEncoded encodes a Host-supplied Value as the Message Layer carries it,
// refusing handles and Function Values from another Group first.
func (b *zigGroup) zigEncoded(v Value) (json.RawMessage, error) {
	if err := b.zigDataOnly(v); err != nil {
		return nil, err
	}
	raw, err := corevalue.EncodeWire(v.inner, false, func(f *corevalue.FunctionData) (string, error) {
		return `{"$function":[` + corevalue.JSONString(f.Home, false) + "," + corevalue.JSONString(wireDisplay(f), false) + "," + corevalue.JSONString(f.Code, false) + "]}", nil
	})
	if err != nil {
		return nil, &HostError{InvalidValue, err.Error()}
	}
	return json.RawMessage(raw), nil
}

func wireDisplay(f *corevalue.FunctionData) string {
	shown, _ := f.WireDisplay()
	return shown
}

// decodeValue reads a Value Encoding from the guest. A Function Value
// becomes an opaque value of this Group: its Code is the guest's token, so
// equal tokens are equal values, and its display is the guest's.
func (b *zigGroup) decodeValue(raw []byte) (Value, error) {
	resolve := func(kind, id string) (corevalue.Value, error) {
		o, ok := b.resolve(kind, id)
		if !ok {
			return corevalue.Value{}, fmt.Errorf("object not resolved")
		}
		return o.Value().inner, nil
	}
	v, err := corevalue.DecodeWire(raw, resolve, func(payload corevalue.Value) (corevalue.Value, error) {
		parts := payload.Items()
		if len(parts) != 3 || parts[0].Kind != corevalue.Text || parts[1].Kind != corevalue.Text || parts[2].Kind != corevalue.Text {
			return corevalue.Value{}, fmt.Errorf("invalid $function tag")
		}
		return corevalue.Fields{Kind: corevalue.Function, Function: &corevalue.FunctionData{Home: parts[0].Text(), CodeState: corevalue.WireFunction{Display: parts[1].Text()}, Code: parts[2].Text(), Group: b.group}}.Value(), nil
	})
	if err != nil {
		return Nothing, &HostError{InvalidValue, err.Error()}
	}
	return Value{v}, nil
}
func (b *zigGroup) zigScriptFailure(e *ScriptError) (map[string]any, error) {
	if !utf8.ValidString(e.Code) || !utf8.ValidString(e.Message) {
		return nil, &HostError{InvalidValue, "invalid UTF-8 in a failure"}
	}
	data, err := b.zigEncoded(e.Data)
	if err != nil {
		return nil, err
	}
	out := map[string]any{"code": e.Code, "data": data}
	if e.Message != "" {
		out["message"] = e.Message
	}
	return out, nil
}
