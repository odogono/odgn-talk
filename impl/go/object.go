package northtalk

import (
	"slices"
	"unicode/utf8"

	"northtalk.org/go/internal/shape"
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

// ObjectElements is an Object Kind's ordered, named collection of Host
// Objects (#1143). Shape is an Object Shape or a OneOf of them; results are
// checked against it, wrapped in Optional. At gets a nonzero index: positive
// from the front, negative from the end. Its callbacks run inside the Run,
// synchronously and read-only, like a property's Get.
type ObjectElements struct {
	Shape     Shape
	Count     func(o *Object) (Value, error)
	At        func(o *Object, index int64) (Value, error)
	Find      func(o *Object, name string) (Value, error)
	CountCost Cost
	AtCost    Cost
	FindCost  Cost
}

type ObjectKindDef struct {
	Name  string
	Props []Prop
	// ParentKinds lists the kinds that may be this kind's parent, for the
	// Host Manifest only. SetParent doesn't check it.
	ParentKinds []string
	// Elements is nil for a kind with no collection.
	Elements *ObjectElements
}

func validCost(cost Cost) bool {
	return cost.Fuel >= 0 && cost.Alloc >= 0 && cost.Fuel <= 9007199254740991 && cost.Alloc <= 9007199254740991
}

// objectElements copies a collection declaration. Its Shape is an Object
// Shape or a nonempty choice of Object Shapes of distinct kinds.
func objectElements(e *ObjectElements) (*ObjectElements, error) {
	if e == nil {
		return nil, nil
	}
	if e.Count == nil || e.At == nil || e.Find == nil {
		return nil, &HostError{InvalidValue, "an Object Collection needs Count, At and Find"}
	}
	for _, cost := range []Cost{e.CountCost, e.AtCost, e.FindCost} {
		if !validCost(cost) {
			return nil, &HostError{InvalidValue, "invalid Object Collection cost"}
		}
	}
	s := e.Shape.inner
	choices := []shape.Shape{s}
	if s.Kind == "oneOf" {
		choices = s.Of
	}
	seen := map[string]bool{}
	for _, c := range choices {
		if c.Kind != "object" || seen[c.Name] {
			return nil, &HostError{InvalidValue, "an Object Collection Shape must be an Object Shape or a choice of distinct ones"}
		}
		seen[c.Name] = true
	}
	if len(choices) == 0 {
		return nil, &HostError{InvalidValue, "an Object Collection Shape must be an Object Shape or a choice of distinct ones"}
	}
	copied := *e
	copied.Shape = Shape{cloneShape(s)}
	return &copied, nil
}

func cloneShape(s shape.Shape) shape.Shape {
	s.Of = slices.Clone(s.Of)
	return s
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
			if !validCost(cost) {
				return nil, &HostError{InvalidValue, "invalid property cost"}
			}
		}
		kind.props[prop.Name] = prop
	}
	elements, err := objectElements(def.Elements)
	if err != nil {
		return nil, err
	}
	kind.elements = elements
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
func (g *Group) Object(kind *ObjectKind, id string, native any, opts ...ObjectOption) (*Object, error) {
	if kind == nil || kind.name == "" || !utf8.ValidString(id) {
		return nil, &HostError{InvalidValue, "invalid Object kind or id"}
	}
	var options objectOptions
	for _, opt := range opts {
		opt(&options)
	}
	if options.parent != nil && options.parent.group != g {
		return nil, &HostError{WrongGroup, "the parent isn't this Group's"}
	}
	key := objectKey{kind.name, id}
	// The guest registers it outside the Group lock; it refuses a
	// concurrent duplicate itself.
	g.mu.Lock()
	duplicate := g.objects[key] != nil
	g.mu.Unlock()
	if duplicate {
		return nil, &HostError{DuplicateObjectID, "Object kind/id already registered"}
	}
	if err := g.backend.object(kind, id, options.parent); err != nil {
		return nil, err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.objects == nil {
		g.objects = map[objectKey]*Object{}
	}
	if g.objects[key] != nil {
		return nil, &HostError{DuplicateObjectID, "Object kind/id already registered"}
	}
	o := &Object{kind: kind, id: id, native: native, group: g}
	g.objects[key] = o
	return o, nil
}

// ObjectOption configures Object.
type ObjectOption func(*objectOptions)

type objectOptions struct{ parent *Object }

// WithParent makes the object with this parent, set at once, even inside a
// Pump (ADR 0152). A disposed parent is "invalid value".
func WithParent(parent *Object) ObjectOption {
	return func(o *objectOptions) { o.parent = parent }
}

// ObjectByID returns the handle with this Object Kind name and id in this
// Group, disposed or not. It is how a Host reaches the handles Restore made.
// It may be called from any goroutine, including a Host callback.
func (g *Group) ObjectByID(kind, id string) (*Object, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	o := g.objects[objectKey{kind, id}]
	return o, o != nil
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
	return g.backend.dispose(o)
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
	// Ownership is the binding's; cycles and disposal are the guest's.
	if o == nil || o.group != g || parent != nil && parent.group != g {
		g.recordRefusal("set-parent", nil, fields, WrongGroup)
		return &HostError{WrongGroup, "invalid parent relationship"}
	}
	return g.backend.setParent(o, parent)
}
