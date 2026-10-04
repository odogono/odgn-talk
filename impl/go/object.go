package northtalk

import (
	"slices"
	"unicode/utf8"
)

const DuplicateObjectID HostErrorCode = "duplicate object id"

// Prop declares a Host property and its costs. Property execution is deferred;
// registered handles currently support Core-held identity and disposal only.
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
// ParentKinds is manifest metadata; parent routing remains deferred.
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
// Owning Scripts and parent relationships remain deferred with Message Paths.
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
