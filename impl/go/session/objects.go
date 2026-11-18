package session

import (
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"strings"

	talk "northtalk.org/go"
	"northtalk.org/go/internal/sessionio"
	v "northtalk.org/go/internal/value"
)

type objectReference struct{ kind, id string }

func (r objectReference) raw() json.RawMessage {
	return rawJSON(map[string]string{"kind": r.kind, "id": r.id})
}

// Objects is the context Environment.Objects declares live Host Objects in.
// The session's guest holds them; each property get or set, and each Object
// Collection count, at or find, is a `prop` need Go answers by calling the
// kind's callbacks. Request and Action hand the session Host actions.
type Objects struct {
	h    *Host
	core *talk.Core
	// The kinds declared, with the callbacks Go answers through.
	kinds   map[string]*talk.ObjectKind
	defs    map[string]talk.ObjectKindDef
	encoded map[string]string
	names   map[*talk.ObjectKind]string
	objects map[objectReference]*talk.Object
	// Kinds and objects the session made, which Go never calls.
	unknown map[string]*talk.ObjectKind
	// Envelopes declared before the session opens, or during a crossing,
	// which go with its answer; nil between Host calls, when each goes at
	// once.
	pending  []string
	opened   bool
	crossing bool
}

func newObjects(h *Host) *Objects {
	return &Objects{h: h, core: talk.New(), kinds: map[string]*talk.ObjectKind{}, defs: map[string]talk.ObjectKindDef{}, encoded: map[string]string{}, names: map[*talk.ObjectKind]string{}, objects: map[objectReference]*talk.Object{}, unknown: map[string]*talk.ObjectKind{}}
}

// declare hands the session an envelope: with the opening, with a
// crossing's answer, or else at once.
func (o *Objects) declare(e Envelope) {
	text := writeEnvelope(e)
	if !o.opened || o.crossing {
		o.pending = append(o.pending, text)
		return
	}
	o.h.timed("session-input", map[string]any{"envelope": text})
}

// opening is `session-open`'s `objects`: what Environment.Objects declared,
// and its initial bindings.
func (o *Objects) opening(bindings map[string]*talk.Object) []any {
	refs := Envelope{}
	for name, x := range bindings {
		refs[name] = (objectReference{o.names[x.Kind()], x.ID()}).raw()
	}
	texts := []any{}
	for _, t := range o.pending {
		texts = append(texts, t)
	}
	texts = append(texts, writeEnvelope(Envelope{"type": rawJSON("setup"), "objects": json.RawMessage(writeEnvelope(refs))}))
	o.pending = nil
	o.opened = true
	return texts
}

// DefineKind declares an Object Kind, whose callbacks answer the session's
// crossings.
func (o *Objects) DefineKind(def talk.ObjectKindDef) (*talk.ObjectKind, error) {
	props := append([]talk.Prop{}, def.Props...)
	slices.SortFunc(props, func(a, b talk.Prop) int { return strings.Compare(a.Name, b.Name) })
	rows := []json.RawMessage{}
	for i := range props {
		p := props[i]
		if reflect.ValueOf(p.Shape).IsZero() {
			p.Shape = talk.AnyShape
			props[i].Shape = p.Shape
		}
		row := Envelope{"name": rawJSON(p.Name), "shape": shapeDeclaration(p.Shape), "readOnly": rawJSON(p.Set == nil), "getCost": rawJSON(map[string]int64{"fuel": p.GetCost.Fuel, "alloc": p.GetCost.Alloc})}
		if p.Set != nil {
			row["setCost"] = rawJSON(map[string]int64{"fuel": p.SetCost.Fuel, "alloc": p.SetCost.Alloc})
		}
		rows = append(rows, json.RawMessage(writeEnvelope(row)))
	}
	parents := def.ParentKinds
	if parents == nil {
		parents = []string{}
	}
	e := Envelope{"type": rawJSON("kind"), "name": rawJSON(def.Name), "props": rawJSON(rows), "parentKinds": rawJSON(parents)}
	if def.Elements != nil {
		e["elements"] = elementsDeclaration(def.Elements)
	}
	encoded := writeEnvelope(e)
	if old, ok := o.encoded[def.Name]; ok {
		if old != encoded {
			return nil, &talk.HostError{Code: talk.InvalidValue, Detail: "conflicting Object Kind"}
		}
		return o.kinds[def.Name], nil
	}
	def.Props = props
	k, err := o.core.DefineObjectKind(def)
	if err != nil {
		return nil, err
	}
	o.kinds[def.Name] = k
	o.defs[def.Name] = def
	o.names[k] = def.Name
	o.encoded[def.Name] = encoded
	o.declare(e)
	return k, nil
}

// Object declares a Host Object of a kind DefineKind declared.
func (o *Objects) Object(kind *talk.ObjectKind, id string, native any) (*talk.Object, error) {
	name, ok := o.names[kind]
	if !ok {
		return nil, &talk.HostError{Code: talk.InvalidValue, Detail: "kind must be defined through Objects"}
	}
	r := objectReference{name, id}
	if old := o.objects[r]; old != nil {
		return old, nil
	}
	x := sessionio.DetachedObject(kind, id, native).(*talk.Object)
	o.objects[r] = x
	o.declare(Envelope{"type": rawJSON("object"), "object": r.raw()})
	return x, nil
}

// kindName is a kind's name, whether Go declared it or the session made it.
func (o *Objects) kindName(k *talk.ObjectKind) string {
	if name, ok := o.names[k]; ok {
		return name
	}
	for name, u := range o.unknown {
		if u == k {
			return name
		}
	}
	return ""
}

// declared reports whether Go declared the object, for a live Restore with
// no ResolveObject.
func (o *Objects) declared(kind, id string) bool {
	return o.objects[objectReference{kind, id}] != nil
}

// named is the Host Object kind and id name: one Go declared, or one the
// session made, held under a kind with no callbacks.
func (o *Objects) named(kind, id string) *talk.Object {
	r := objectReference{kind, id}
	if x := o.objects[r]; x != nil {
		return x
	}
	k := o.kinds[kind]
	if k == nil {
		if k = o.unknown[kind]; k == nil {
			var err error
			if k, err = o.core.DefineObjectKind(talk.ObjectKindDef{Name: kind}); err != nil {
				panic(err)
			}
			o.unknown[kind] = k
		}
	}
	x := sessionio.DetachedObject(k, id, nil).(*talk.Object)
	o.objects[r] = x
	return x
}

// Encode is x as a session envelope holds it: a Host Object by its identity,
// and a Function Value the session exposed by its handle.
func (o *Objects) Encode(x talk.Value) json.RawMessage {
	switch x.Kind() {
	case talk.KindFunction:
		handle, ok := sessionio.FunctionHandle(x)
		if !ok {
			envelopeError("a Function Value the session didn't expose")
		}
		return json.RawMessage(`{"$sessionFunction":` + v.JSONString(handle, false) + `}`)
	case talk.KindList:
		xs := []json.RawMessage{}
		for i := 1; i <= x.Len(); i++ {
			xs = append(xs, o.Encode(x.Index(i)))
		}
		return rawJSON(xs)
	case talk.KindMap:
		ps := x.Entries()
		tagged := slices.ContainsFunc(ps, func(p talk.Pair) bool { return strings.HasPrefix(p.Key, "$") })
		var b strings.Builder
		if tagged {
			b.WriteString(`{"$map":[`)
		} else {
			b.WriteByte('{')
		}
		for i, p := range ps {
			if i > 0 {
				b.WriteByte(',')
			}
			if tagged {
				b.WriteByte('[')
			}
			b.WriteString(v.JSONString(p.Key, false))
			if tagged {
				b.WriteByte(',')
			} else {
				b.WriteByte(':')
			}
			b.Write(o.Encode(p.Val))
			if tagged {
				b.WriteByte(']')
			}
		}
		if tagged {
			b.WriteString("]}")
		} else {
			b.WriteByte('}')
		}
		return json.RawMessage(b.String())
	case talk.KindObject:
		obj, _ := x.AsObject()
		if obj == nil || o.objects[objectReference{o.kindName(obj.Kind()), obj.ID()}] == nil {
			envelopeError("a Host Object the session doesn't hold")
		}
	}
	b, err := talk.EncodeValue(x)
	if err != nil {
		envelopeError(err.Error())
	}
	return b
}

func (o *Objects) decode(raw []byte) talk.Value {
	x, err := sessionio.Decode(raw, func(kind, id string) (any, bool) { return o.named(kind, id), true }, func(h string) (any, bool) { return sessionio.SessionFunction(h), true })
	if err != nil {
		envelopeError(err.Error())
	}
	return x.(talk.Value)
}

// Request hands the session a Host action, encoding each Value as a session
// envelope holds it, and returns its reply. During a crossing, the action
// goes with the crossing's answer, and its reply is nil: the session records
// it.
func (o *Objects) Request(fields map[string]any) Envelope {
	e := Envelope{}
	for k, x := range fields {
		e[k] = o.requestValue(x)
	}
	return o.Action(e)
}

// Action hands the session a Host action whose Values are already encoded,
// as Encode writes them.
func (o *Objects) Action(request Envelope) Envelope {
	validateRequest(request)
	e := Envelope{"type": rawJSON("input"), "request": json.RawMessage(writeEnvelope(request))}
	if !o.opened || o.crossing {
		o.pending = append(o.pending, writeEnvelope(e))
		return nil
	}
	o.h.lastEnvelope = ""
	o.declare(e)
	recorded, err := ParseEnvelope(o.h.lastEnvelope)
	if err != nil || envelopeText(recorded["type"]) != "input" {
		envelopeError("the session recorded no Host action")
	}
	return envelopeObject(recorded["reply"])
}

func (o *Objects) requestValue(x any) json.RawMessage {
	switch x := x.(type) {
	case talk.Value:
		return o.Encode(x)
	case map[string]any:
		e := Envelope{}
		for k, val := range x {
			e[k] = o.requestValue(val)
		}
		return json.RawMessage(writeEnvelope(e))
	case []talk.Value:
		xs := []json.RawMessage{}
		for _, val := range x {
			xs = append(xs, o.Encode(val))
		}
		return rawJSON(xs)
	case []any:
		xs := []json.RawMessage{}
		for _, val := range x {
			xs = append(xs, o.requestValue(val))
		}
		return rawJSON(xs)
	default:
		return rawJSON(x)
	}
}

// cross answers a `prop` need through the object's callbacks, with what
// they declared and did meanwhile.
func (o *Objects) cross(raw json.RawMessage) (answer map[string]any) {
	var need struct {
		Object   json.RawMessage `json:"object"`
		Prop     string          `json:"prop"`
		Op       string          `json:"op"`
		Value    json.RawMessage `json:"value"`
		Selector json.RawMessage `json:"selector"`
	}
	if err := json.Unmarshal(raw, &need); err != nil {
		panic(err)
	}
	var ref struct {
		Object [2]string `json:"$object"`
	}
	if err := json.Unmarshal(need.Object, &ref); err != nil {
		panic(err)
	}
	x := o.objects[objectReference{ref.Object[0], ref.Object[1]}]
	def, known := o.defs[ref.Object[0]]
	o.crossing = true
	o.pending = nil
	defer func() {
		o.crossing = false
		if p := recover(); p != nil {
			// A callback that panics is a Host error, as a Group's is.
			answer = map[string]any{"hostError": true}
		}
		if len(o.pending) > 0 {
			envelopes := []any{}
			for _, t := range o.pending {
				envelopes = append(envelopes, t)
			}
			answer["envelopes"] = envelopes
		}
		o.pending = nil
	}()
	if x == nil || !known {
		return map[string]any{"hostError": true}
	}
	result := func(value talk.Value, err error) map[string]any {
		if err != nil {
			return failed(err)
		}
		return map[string]any{"value": o.Encode(value)}
	}
	if need.Prop == "elements" && need.Op != "" {
		elements := def.Elements
		if elements == nil {
			return map[string]any{"hostError": true}
		}
		switch need.Op {
		case "count":
			return result(elements.Count(x))
		case "at":
			var index int64
			if err := json.Unmarshal(need.Selector, &index); err != nil {
				return map[string]any{"hostError": true}
			}
			return result(elements.At(x, index))
		case "find":
			var name string
			if err := json.Unmarshal(need.Selector, &name); err != nil {
				return map[string]any{"hostError": true}
			}
			return result(elements.Find(x, name))
		}
		return map[string]any{"hostError": true}
	}
	i := slices.IndexFunc(def.Props, func(p talk.Prop) bool { return p.Name == need.Prop })
	if i < 0 {
		return map[string]any{"hostError": true}
	}
	p := def.Props[i]
	if need.Value != nil {
		if p.Set == nil {
			return map[string]any{"hostError": true}
		}
		if err := p.Set(x, o.decode(need.Value)); err != nil {
			return failed(err)
		}
		return map[string]any{"ok": true}
	}
	return result(p.Get(x))
}

// failed is a callback's error as `prop-result` gives it: a script error's
// map, or a Host error.
func failed(err error) map[string]any {
	var script *talk.ScriptError
	if !errors.As(err, &script) {
		return map[string]any{"hostError": true}
	}
	f := map[string]any{"code": script.Code, "message": script.Message}
	if script.Data.Kind() != talk.KindNothing {
		raw, e := talk.EncodeValue(script.Data)
		if e != nil {
			return map[string]any{"hostError": true}
		}
		f["data"] = raw
	}
	return map[string]any{"fail": f}
}

// Shape declarations are provided by the Core, which holds the private Shape.
func shapeDeclaration(s talk.Shape) json.RawMessage {
	var data any
	json.Unmarshal(sessionio.Shape(s).(json.RawMessage), &data)
	return rawJSON(data)
}
