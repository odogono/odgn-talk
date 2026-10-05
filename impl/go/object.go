package northtalk

import (
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
	"slices"
	"unicode/utf8"
)

const DuplicateObjectID HostErrorCode = "duplicate object id"

// Prop declares a Host property. Get and Set run inside Pump, after the
// instruction and declared cost are paid. Results and failures are validated
// and their conversion charged. Set nil makes a property read-only. Load and
// Reload reject writes when the Object binding and literal key are known.
type Prop struct {
	Name    string
	Shape   Shape
	Get     func(o *Object) (Value, error)
	Set     func(o *Object, v Value) error
	GetCost Cost
	SetCost Cost
}
type ObjectKindDef struct {
	Name        string
	Props       []Prop
	ParentKinds []string
}

// DefineObjectKind copies a reusable process-level Object Kind declaration.
// ParentKinds is manifest metadata; it does not constrain SetParent.
func (c *Core) DefineObjectKind(def ObjectKindDef) (*ObjectKind, error) {
	if def.Name == "" || !utf8.ValidString(def.Name) {
		return nil, &HostError{InvalidValue, "invalid Object Kind name"}
	}
	kind := &ObjectKind{name: def.Name, props: map[string]Prop{}, parentKinds: slices.Clone(def.ParentKinds)}
	for _, prop := range def.Props {
		if _, duplicate := kind.props[prop.Name]; duplicate || prop.Name == "" || !utf8.ValidString(prop.Name) || prop.Get == nil || !validShape(prop.Shape.inner) {
			return nil, &HostError{InvalidValue, "invalid property declaration"}
		}
		for _, cost := range []Cost{prop.GetCost, prop.SetCost} {
			if cost.Fuel < 0 || cost.Alloc < 0 || cost.Fuel > 9007199254740991 || cost.Alloc > 9007199254740991 {
				return nil, &HostError{InvalidValue, "invalid property cost"}
			}
		}
		kind.props[prop.Name] = prop
	}
	c.mu.Lock()
	if c.objectKinds == nil {
		c.objectKinds = map[string]*ObjectKind{}
	}
	c.objectKinds[kind.name] = kind
	c.mu.Unlock()
	return kind, nil
}

// Object registers a stable kind/id pair in this Group. Registration and
// Dispose may be called from any goroutine, including a Host callback.
func (g *Group) Object(kind *ObjectKind, id string, native any) (*Object, error) {
	if kind == nil || kind.name == "" || !utf8.ValidString(id) {
		return nil, &HostError{InvalidValue, "invalid Object kind or id"}
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.objects == nil {
		g.objects = map[objectKey]*Object{}
	}
	key := objectKey{kind.name, id}
	if g.objects[key] != nil {
		return nil, &HostError{DuplicateObjectID, "Object kind/id already registered"}
	}
	o := &Object{kind: kind, id: id, native: native, group: g}
	g.objects[key] = o
	return o, nil
}

type objectKey struct{ kind, id string }

// Dispose queues an idempotent lifecycle change for the next Pump. A disposed
// handle retains identity and encoding and remains a valid Group-owned Value.
// Disposing an owner stops its Script; routing skips the disposed Object.
func (g *Group) Dispose(o *Object) error {
	if o == nil || o.group != g {
		object := "nothing"
		if o != nil && o.kind != nil {
			object = o.Value().String()
		}
		g.recordRefusal("dispose", nil, map[string]string{"object": object}, WrongGroup)
		return &HostError{WrongGroup, "Object does not belong to Group"}
	}
	g.mu.Lock()
	g.inputs = append(g.inputs, delivery{kind: "dispose", object: o, fields: map[string]string{"object": o.Value().String()}})
	ready := g.options.OnReady
	g.mu.Unlock()
	if ready != nil {
		ready()
	}
	return nil
}

func objectProperties(bindings map[string]corevalue.Value) map[string]map[string]bool {
	out := map[string]map[string]bool{}
	for name, v := range bindings {
		o := v.Object.Handle.(*Object)
		props := map[string]bool{}
		for key, prop := range o.kind.props {
			props[key] = prop.Set != nil
		}
		out[name] = props
	}
	return out
}

const ParentCycle HostErrorCode = "parent cycle"

func (*HostError) isReport() {}

// SetParent queues a parent change, rejecting known cycles and disposed children.
// ParentKinds is metadata, not a restriction on the Message Path.
func (g *Group) SetParent(o, parent *Object) error {
	fields := map[string]string{"object": "nothing", "parent": "nothing"}
	if o != nil {
		fields["object"] = o.Value().String()
	}
	if parent != nil {
		fields["parent"] = parent.Value().String()
	}
	g.mu.Lock()
	code := g.parentError(o, parent)
	if code != "" {
		g.mu.Unlock()
		g.recordRefusal("set-parent", nil, fields, code)
		return &HostError{code, "invalid parent relationship"}
	}
	g.inputs = append(g.inputs, delivery{kind: "set-parent", object: o, parent: parent, fields: fields})
	ready := g.options.OnReady
	g.mu.Unlock()
	if ready != nil {
		ready()
	}
	return nil
}

// Caller holds g.mu, including when applying queued changes.
func (g *Group) parentError(o, parent *Object) HostErrorCode {
	if o == nil || o.group != g || parent != nil && parent.group != g {
		return WrongGroup
	}
	if o.disposed.Load() {
		return InvalidValue
	}
	for p := parent; p != nil; p = p.parent {
		if p == o {
			return ParentCycle
		}
	}
	return ""
}
func ownerProperties(o *Object) map[string]bool {
	if o == nil {
		return nil
	}
	return objectProperties(map[string]corevalue.Value{"me": o.Value().inner})["me"]
}
