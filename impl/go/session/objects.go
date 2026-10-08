package session

import (
	"encoding/json"
	"errors"
	"fmt"
	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/sessionio"
	v "github.com/odogono/odgn-talk/impl/go/internal/value"
	"math/big"
	"reflect"
	"slices"
	"strings"
)

type objectReference struct{ kind, id string }

func (r objectReference) raw() json.RawMessage {
	return rawJSON(map[string]string{"kind": r.kind, "id": r.id})
}

type replayEnvelope struct {
	index    int
	item     Item
	envelope Envelope
	consumed bool
}

// Objects is the recording context supplied to Environment.Objects. Host
// adapters register actual definitions here and use Action for external inputs.
type traceAction struct{ kind, id string }
type Objects struct {
	recorded                   []Item
	commandCursor              int
	playbackError              error
	queuedTraceActions         []traceAction
	traceSaves                 map[string][]traceAction
	core                       *talk.Core
	group                      *talk.Group
	record                     func(Item)
	kinds                      map[string]*talk.ObjectKind
	declarations               map[string]string
	names                      map[*talk.ObjectKind]string
	objects                    map[objectReference]*talk.Object
	crossing, exposure, handle *big.Int
	handles                    map[string]talk.Value
	supplied                   map[any]string
	replay                     []*replayEnvelope
	playback, enabled, active  bool
	outcomes                   []Envelope
	resolving                  []Envelope
}

func newObjects(core *talk.Core, g *talk.Group, record func(Item), items []Item, enabled bool) *Objects {
	o := &Objects{core: core, group: g, record: record, kinds: map[string]*talk.ObjectKind{}, declarations: map[string]string{}, names: map[*talk.ObjectKind]string{}, objects: map[objectReference]*talk.Object{}, crossing: new(big.Int), exposure: new(big.Int), handle: new(big.Int), handles: map[string]talk.Value{}, playback: items != nil, enabled: enabled}
	for i, item := range items {
		if item.Kind == "envelope" {
			e, err := ParseEnvelope(item.Text)
			must(err)
			o.replay = append(o.replay, &replayEnvelope{index: i, item: item, envelope: e})
		}
	}
	o.supplied = map[any]string{}
	o.recorded = items
	o.attach(g)
	return o
}
func (o *Objects) attach(g *talk.Group) {
	o.group = g
	sessionio.Attach(g, func(tree any) { o.expose(tree) })
	for r := range o.objects {
		if x, ok := g.ObjectByID(r.kind, r.id); ok {
			o.objects[r] = x
			o.names[x.Kind()] = r.kind
		}
	}
}
func (o *Objects) emit(e Envelope) { o.record(Item{Kind: "envelope", Text: writeEnvelope(e)}) }
func (o *Objects) next() *replayEnvelope {
	for _, r := range o.replay {
		if !r.consumed {
			return r
		}
	}
	return nil
}
func (o *Objects) nextType() string {
	if r := o.next(); r != nil {
		return envelopeText(r.envelope["type"])
	}
	return ""
}
func (o *Objects) consume(typ string) Envelope {
	r := o.next()
	if r == nil || o.nextType() != typ {
		envelopeError("expected " + typ)
	}
	r.consumed = true
	o.record(r.item)
	return r.envelope
}
func (o *Objects) DefineKind(def talk.ObjectKindDef) (*talk.ObjectKind, error) {
	// The passive declaration hook uses authoritative Shape and cost data.
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
		props[i].Get = func(x *talk.Object) (talk.Value, error) {
			return o.property(x, p.Name, "get", talk.Nothing, func() (talk.Value, error) { return p.Get(x) })
		}
		if p.Set != nil {
			props[i].Set = func(x *talk.Object, value talk.Value) error {
				_, err := o.property(x, p.Name, "set", value, func() (talk.Value, error) { return talk.Nothing, p.Set(x, value) })
				return err
			}
		}
	}
	parents := def.ParentKinds
	if parents == nil {
		parents = []string{}
	}
	e := Envelope{"type": rawJSON("kind"), "name": rawJSON(def.Name), "props": rawJSON(rows), "parentKinds": rawJSON(parents)}
	encoded := writeEnvelope(e)
	if old, ok := o.declarations[def.Name]; ok {
		if old != encoded {
			envelopeError("conflicting kind")
		}
		return o.kinds[def.Name], nil
	}
	def.Props = props
	k, err := o.core.DefineObjectKind(def)
	if err != nil {
		return nil, err
	}
	o.kinds[def.Name] = k
	o.names[k] = def.Name
	o.declarations[def.Name] = encoded
	if !o.playback {
		o.emit(e)
	}
	return k, nil
}
func (o *Objects) Object(kind *talk.ObjectKind, id string, native any) (*talk.Object, error) {
	name, ok := o.names[kind]
	if !ok {
		envelopeError("kind must be defined through Objects")
	}
	r := objectReference{name, id}
	if old := o.objects[r]; old != nil {
		return old, nil
	}
	x, err := o.group.Object(kind, id, native)
	if err != nil {
		return nil, err
	}
	o.objects[r] = x
	if !o.playback {
		o.emit(Envelope{"type": rawJSON("object"), "object": r.raw()})
	}
	return x, nil
}
func (o *Objects) ref(raw []byte) *talk.Object {
	r := envelopeRef(raw)
	x := o.objects[r]
	if x == nil {
		envelopeError("unknown object")
	}
	return x
}
func (o *Objects) registrations() {
	for o.nextType() == "kind" || o.nextType() == "object" {
		switch o.nextType() {
		case "kind":
			e := o.consume("kind")
			name := envelopeText(e["name"])
			if o.kinds[name] != nil {
				envelopeError("duplicate kind")
			}
			def := talk.ObjectKindDef{Name: name}
			json.Unmarshal(e["parentKinds"], &def.ParentKinds)
			var rows []Envelope
			json.Unmarshal(e["props"], &rows)
			for _, p := range rows {
				prop := talk.Prop{Name: envelopeText(p["name"]), Shape: decodeEnvelopeShape(p["shape"]), GetCost: decodeEnvelopeCost(p["getCost"]), Get: func(*talk.Object) (talk.Value, error) { panic("external getter in replay") }}
				if !envelopeBool(p["readOnly"]) {
					prop.SetCost = decodeEnvelopeCost(p["setCost"])
					prop.Set = func(*talk.Object, talk.Value) error { return nil }
				}
				def.Props = append(def.Props, prop)
			}
			_, err := o.DefineKind(def)
			must(err)
		case "object":
			e := o.consume("object")
			r := envelopeRef(e["object"])
			if o.objects[r] != nil {
				envelopeError("duplicate object")
			}
			k := o.kinds[r.kind]
			if k == nil {
				envelopeError("unknown kind")
			}
			_, err := o.Object(k, r.id, struct{}{})
			must(err)
		}
	}
}
func (o *Objects) initial(bindings map[string]*talk.Object) {
	if o.playback {
		return
	}
	if !o.enabled {
		return
	}
	refs := Envelope{}
	for name, x := range bindings {
		refs[name] = (objectReference{o.names[x.Kind()], x.ID()}).raw()
	}
	o.emit(Envelope{"type": rawJSON("setup"), "objects": json.RawMessage(writeEnvelope(refs))})
}
func (o *Objects) preload() map[string]*talk.Object {
	o.registrations()
	bindings := map[string]*talk.Object{}
	if o.nextType() != "setup" {
		if len(o.replay) > 0 {
			envelopeError("missing setup")
		}
		return bindings
	}
	e := o.consume("setup")
	for name, r := range envelopeObject(e["objects"]) {
		bindings[name] = o.ref(r)
	}
	return bindings
}
func (o *Objects) Encode(x talk.Value) json.RawMessage {
	switch x.Kind() {
	case talk.KindFunction:
		found := o.supplied[sessionio.FunctionIdentity(x)]
		if found == "" {
			envelopeError("unexposed/invalidated function")
		}
		return json.RawMessage(`{"$sessionFunction":` + v.JSONString(found, false) + `}`)
	case talk.KindList:
		xs := []json.RawMessage{}
		for i := 1; i <= x.Len(); i++ {
			xs = append(xs, o.Encode(x.Index(i)))
		}
		return rawJSON(xs)
	case talk.KindMap:
		ps := x.Entries()
		tagged := false
		for _, p := range ps {
			if strings.HasPrefix(p.Key, "$") {
				tagged = true
			}
		}
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
		if obj == nil || o.names[obj.Kind()] == "" {
			envelopeError("unregistered object")
		}
	}
	b, err := talk.EncodeValue(x)
	must(err)
	return b
}
func (o *Objects) decode(raw []byte) talk.Value {
	x, err := sessionio.Decode(raw, func(kind, id string) (any, bool) { x, ok := o.objects[objectReference{kind, id}]; return x, ok }, func(h string) (any, bool) { x, ok := o.handles[h]; return x, ok })
	if err != nil {
		envelopeError(err.Error())
	}
	return x.(talk.Value)
}
func (o *Objects) property(x *talk.Object, name, op string, input talk.Value, callback func() (talk.Value, error)) (result talk.Value, err error) {
	if o.active {
		envelopeError("reentrant callback")
	}
	if op == "set" {
		o.expose(talk.List(input))
	}
	o.crossing.Add(o.crossing, big.NewInt(1))
	r := objectReference{o.names[x.Kind()], x.ID()}
	begin := Envelope{"type": rawJSON("property-begin"), "crossing": counterJSON(o.crossing), "object": r.raw(), "property": rawJSON(name), "operation": rawJSON(op)}
	if op == "set" {
		begin["value"] = o.Encode(input)
	}
	if o.playback {
		defer func() {
			if p := recover(); p != nil {
				if err, ok := p.(error); ok {
					o.playbackError = err
				}
				panic(p)
			}
		}()
		e := o.consume("property-begin")
		if envelopeCounter(e["crossing"]).Cmp(o.crossing) != 0 || envelopeRef(e["object"]) != r || envelopeText(e["property"]) != name || envelopeText(e["operation"]) != op || op == "set" && string(e["value"]) != string(begin["value"]) {
			envelopeError("unmatched property crossing")
		}
		o.active = true
		defer func() { o.active = false }()
		for o.nextType() == "kind" || o.nextType() == "object" || o.nextType() == "input" {
			if o.nextType() == "input" {
				o.replayInput()
			} else {
				o.registrations()
			}
		}
		end := o.consume("property-end")
		if envelopeCounter(end["crossing"]).Cmp(o.crossing) != 0 {
			envelopeError("out-of-order property end")
		}
		reply := envelopeObject(end["reply"])
		if raw, ok := reply["value"]; ok {
			if op != "get" {
				envelopeError("value for setter")
			}
			return o.decode(raw), nil
		}
		if raw, ok := reply["ok"]; ok {
			if op != "set" || !envelopeBool(raw) {
				envelopeError("invalid ok")
			}
			return talk.Nothing, nil
		}
		if raw, ok := reply["fail"]; ok {
			f := envelopeObject(raw)
			envelopeFields(f, []string{"code", "message", "data"})
			return talk.Nothing, &talk.ScriptError{Code: envelopeText(f["code"]), Message: envelopeText(f["message"]), Data: o.decode(f["data"])}
		}
		return talk.Nothing, errors.New("recorded Host property failure")
	}
	o.emit(begin)
	o.active = true
	defer func() { o.active = false }()
	defer func() {
		if p := recover(); p != nil {
			o.emit(Envelope{"type": rawJSON("property-end"), "crossing": counterJSON(o.crossing), "reply": rawJSON(map[string]bool{"hostError": true})})
			panic(p)
		}
	}()
	result, err = callback()
	reply := Envelope{}
	if err == nil {
		if op == "set" {
			reply["ok"] = rawJSON(true)
		} else {
			reply["value"] = o.Encode(result)
		}
	} else {
		var script *talk.ScriptError
		if errors.As(err, &script) {
			reply["fail"] = json.RawMessage(writeEnvelope(Envelope{"code": rawJSON(script.Code), "message": rawJSON(script.Message), "data": o.Encode(script.Data)}))
		} else {
			reply["hostError"] = rawJSON(true)
		}
	}
	o.emit(Envelope{"type": rawJSON("property-end"), "crossing": counterJSON(o.crossing), "reply": json.RawMessage(writeEnvelope(reply))})
	return
}
func (o *Objects) expose(tree any) {
	defer func() {
		if p := recover(); p != nil {
			if err, ok := p.(error); ok && o.playback {
				o.playbackError = err
			}
			panic(p)
		}
	}()
	o.exposure.Add(o.exposure, big.NewInt(1))
	if !o.enabled {
		return
	}
	var walk func(reflect.Value, []any)
	walk = func(rv reflect.Value, path []any) {
		if !rv.IsValid() {
			return
		}
		if rv.CanInterface() {
			if x, ok := rv.Interface().(talk.Value); ok {
				switch x.Kind() {
				case talk.KindFunction:
					o.handle.Add(o.handle, big.NewInt(1))
					h := "f" + o.handle.String()
					if o.playback {
						e := o.consume("function")
						if envelopeText(e["handle"]) != h || envelopeCounter(e["exposure"]).Cmp(o.exposure) != 0 || string(e["path"]) != string(rawJSON(path)) {
							envelopeError("invalid function exposure/path")
						}
					} else {
						o.emit(Envelope{"type": rawJSON("function"), "handle": rawJSON(h), "exposure": counterJSON(o.exposure), "path": rawJSON(path)})
					}
					o.handles[h] = x
					o.supplied[sessionio.FunctionIdentity(x)] = h
				case talk.KindList:
					for i := 1; i <= x.Len(); i++ {
						walk(reflect.ValueOf(x.Index(i)), append(slices.Clone(path), i-1))
					}
				case talk.KindMap:
					for _, p := range x.Entries() {
						walk(reflect.ValueOf(p.Val), append(slices.Clone(path), p.Key))
					}
				}
				return
			}
		}
		switch rv.Kind() {
		case reflect.Pointer, reflect.Interface:
			if !rv.IsNil() {
				walk(rv.Elem(), path)
			}
		case reflect.Struct:
			typ := rv.Type()
			for i := 0; i < rv.NumField(); i++ {
				if !rv.Field(i).CanInterface() {
					continue
				}
				name := typ.Field(i).Name
				if name == "Function" {
					name = "Fn"
				}
				name = strings.ToLower(name[:1]) + name[1:]
				walk(rv.Field(i), append(slices.Clone(path), name))
			}
		case reflect.Slice, reflect.Array:
			for i := 0; i < rv.Len(); i++ {
				walk(rv.Index(i), append(slices.Clone(path), i))
			}
		case reflect.Map:
			keys := rv.MapKeys()
			slices.SortFunc(keys, func(a, b reflect.Value) int { return strings.Compare(a.String(), b.String()) })
			for _, k := range keys {
				walk(rv.MapIndex(k), append(slices.Clone(path), k.String()))
			}
		}
	}
	walk(reflect.ValueOf(tree), []any{})
	if o.nextType() == "function" && envelopeCounter(o.next().envelope["exposure"]).Cmp(o.exposure) <= 0 {
		envelopeError(fmt.Sprintf("path is not Function at exposure %s (%T)", o.exposure.String(), tree))
	}
}
func (o *Objects) reports(reports []talk.Report) {
	if o.playbackError != nil {
		panic(o.playbackError)
	}
	for _, r := range reports {
		o.expose(r)
	}
}
func (o *Objects) snapshot(view talk.Inspection) {
	tree := map[string]talk.Value{}
	for _, s := range view.Scripts {
		ps := []talk.Pair{}
		for _, p := range s.Vars {
			ps = append(ps, p)
		}
		m, err := talk.Map(ps...)
		must(err)
		tree[s.Name] = m
	}
	o.expose(tree)
}
func (o *Objects) resolve(kind, id string, callback func(string, string) (any, bool)) (any, bool) {
	r := objectReference{kind, id}
	if o.playback {
		if len(o.resolving) == 0 {
			e := o.consume("resolve")
			json.Unmarshal(e["objects"], &o.resolving)
		}
		if len(o.resolving) == 0 {
			envelopeError("missing resolve")
		}
		index := -1
		for i, row := range o.resolving {
			if envelopeRef(row["object"]) == r {
				index = i
				break
			}
		}
		if index < 0 {
			envelopeError("resolver identity mismatch")
		}
		row := o.resolving[index]
		o.resolving = append(o.resolving[:index], o.resolving[index+1:]...)
		return struct{}{}, envelopeBool(row["resolved"])
	}
	var native any
	ok := false
	if callback != nil {
		native, ok = callback(kind, id)
	}
	o.outcomes = append(o.outcomes, Envelope{"object": r.raw(), "resolved": rawJSON(ok)})
	return native, ok
}
func (o *Objects) restored() {
	if o.playback && len(o.resolving) > 0 {
		envelopeError("leftover resolver outcomes")
	}
	if len(o.outcomes) > 0 {
		slices.SortFunc(o.outcomes, func(a, b Envelope) int {
			x, y := envelopeRef(a["object"]), envelopeRef(b["object"])
			if n := strings.Compare(x.kind, y.kind); n != 0 {
				return n
			}
			return strings.Compare(x.id, y.id)
		})
		rows := []json.RawMessage{}
		for _, r := range o.outcomes {
			rows = append(rows, json.RawMessage(writeEnvelope(r)))
		}
		o.emit(Envelope{"type": rawJSON("resolve"), "objects": rawJSON(rows)})
		o.outcomes = nil
	}
	o.handles = map[string]talk.Value{}
	o.supplied = map[any]string{}
}
func (o *Objects) drain(index int) {
	for _, r := range o.replay {
		if r.index != index || r.consumed {
			continue
		}
		switch o.nextType() {
		case "input":
			o.replayInput()
		case "kind", "object":
			o.registrations()
		default:
			envelopeError("unmatched envelope")
		}
		return
	}
}
func (o *Objects) finish() {
	if o.next() != nil {
		envelopeError("leftover envelopes")
	}
	o.playback = false
}

// Shape declarations are provided by the Core, which holds the private Shape.
func shapeDeclaration(s talk.Shape) json.RawMessage {
	var data any
	json.Unmarshal(sessionio.Shape(s).(json.RawMessage), &data)
	return rawJSON(data)
}

// NewObjectReplay attaches standalone object crossing playback to a Trace Core.
func NewObjectReplay(core *talk.Core, group *talk.Group, items []Item) *Objects {
	return newObjects(core, group, func(Item) {}, items, true)
}
func (o *Objects) Preload() map[string]*talk.Object    { return o.preload() }
func (o *Objects) Attach(group *talk.Group)            { o.attach(group) }
func (o *Objects) Reports(reports []talk.Report)       { o.reports(reports) }
func (o *Objects) Snapshot(view talk.Inspection)       { o.snapshot(view) }
func (o *Objects) Resolve(kind, id string) (any, bool) { return o.resolve(kind, id, nil) }
func (o *Objects) Restored(name string) {
	o.queuedTraceActions = slices.Clone(o.traceSaves[name])
	o.restored()
}
func (o *Objects) Finish() { o.finish() }
func (o *Objects) Handles() map[[2]string]*talk.Object {
	out := map[[2]string]*talk.Object{}
	for r, x := range o.objects {
		out[[2]string{r.kind, r.id}] = x
	}
	return out
}
func (o *Objects) beforeCommand(name string) {
	index := -1
	for i := o.commandCursor; i < len(o.recorded); i++ {
		item := o.recorded[i]
		if item.Kind == "input" && (item.Text == ":"+name || strings.HasPrefix(item.Text, ":"+name+" ") || name == "vars" && o.describeSnapshot(i)) {
			index = i
			break
		}
	}
	if index < 0 {
		return
	}
	o.commandCursor = index + 1
	for {
		row := o.next()
		if row == nil || row.index >= index {
			break
		}
		switch o.nextType() {
		case "input":
			o.replayInputTracked(true)
		case "kind", "object":
			o.registrations()
		default:
			envelopeError("unmatched crossing before command")
		}
	}
}

// A variable describe produces the same vars Input as :vars. Its passive
// value row distinguishes it from declaration-only lookups in the recording.
func (o *Objects) describeSnapshot(index int) bool {
	if !strings.HasPrefix(o.recorded[index].Text, ":describe ") {
		return false
	}
	for _, item := range o.recorded[index+1:] {
		if item.Kind == "input" {
			break
		}
		if item.Kind == "output" && strings.HasPrefix(item.Text, "value ") {
			return true
		}
	}
	return false
}

func (o *Objects) TraceInput(name string, ids []string) bool {
	if slices.Contains([]string{"save", "restore", "vars"}, name) {
		o.beforeCommand(name)
	}
	o.registrations()
	if name == "call-value" {
		name = "call"
	}
	if name == "decide-broadcast" {
		name = "decide"
	}
	for i, a := range o.queuedTraceActions {
		if a.kind == name && (a.id == "" || len(ids) > 0 && a.id == ids[0]) {
			o.queuedTraceActions = append(o.queuedTraceActions[:i], o.queuedTraceActions[i+1:]...)
			return true
		}
	}
	if o.nextType() != "input" {
		return false
	}
	e := envelopeObject(o.next().envelope["request"])
	if envelopeText(e["kind"]) != name {
		return false
	}
	o.replayInput()
	return true
}

func (o *Objects) Saved(name string) {
	if o.traceSaves == nil {
		o.traceSaves = map[string][]traceAction{}
	}
	o.traceSaves[name] = slices.Clone(o.queuedTraceActions)
}

func (o *Objects) CrossesHandles() bool {
	var contains func(talk.Value) bool
	contains = func(x talk.Value) bool {
		if x.Kind() == talk.KindMap {
			ps := x.Entries()
			if len(ps) == 1 && ps[0].Key == "$sessionFunction" {
				h, _ := ps[0].Val.AsText()
				_, ok := o.handles[h]
				if ok {
					return true
				}
			}
			for _, p := range ps {
				if contains(p.Val) {
					return true
				}
			}
		}
		if x.Kind() == talk.KindList {
			for i := 1; i <= x.Len(); i++ {
				if contains(x.Index(i)) {
					return true
				}
			}
		}
		return false
	}
	for _, r := range o.replay {
		if r.consumed {
			continue
		}
		x, err := talk.DecodeJSON([]byte(r.item.Text))
		must(err)
		if contains(x) {
			return true
		}
	}
	return false
}
