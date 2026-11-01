package corpus

import (
	"fmt"

	talk "northtalk.org/go"
	corevalue "northtalk.org/go/internal/value"
)

type objectRef struct{ kind, id string }
type objectReplay map[objectRef]*talk.Object

func setupObjects(core *talk.Core, group *talk.Group, setup Setup, values *replayValues, crossing func(string), records []Record) (objectReplay, error) {
	kinds := map[string]*talk.ObjectKind{}
	rows, _ := setup["objectKinds"].([]any)
	// A collection's Object Shape may name a kind declared later, or its own.
	// Only the name of these placeholders is used; each is then redefined.
	placeholders := map[string]*talk.ObjectKind{}
	for _, raw := range rows {
		name := raw.(Setup)["name"].(string)
		kind, err := core.DefineObjectKind(talk.ObjectKindDef{Name: name})
		if err != nil {
			return nil, err
		}
		placeholders[name] = kind
	}
	collections := newCollectionReplay(values, crossing, records)
	for _, raw := range rows {
		row := raw.(Setup)
		def := talk.ObjectKindDef{Name: row["name"].(string)}
		if raw, ok := row["elements"].(Setup); ok {
			elements, err := collections.declaration(raw, placeholders)
			if err != nil {
				return nil, err
			}
			def.Elements = elements
		}
		parents, _ := row["parentKinds"].([]any)
		for _, parent := range parents {
			def.ParentKinds = append(def.ParentKinds, parent.(string))
		}
		props, _ := row["props"].([]any)
		for _, raw := range props {
			p := raw.(Setup)
			shape := talk.AnyShape
			if raw, ok := p["shape"]; ok {
				var err error
				shape, err = setupShape(raw)
				if err != nil {
					return nil, err
				}
			}
			name := p["name"].(string)
			prop := talk.Prop{Name: name, Shape: shape, Get: func(o *talk.Object) (talk.Value, error) {
				crossing(o.Value().String() + ":" + name + ":get")
				return o.Native().(map[string]talk.Value)[name], nil
			}}
			if p["readOnly"] != true {
				prop.Set = func(o *talk.Object, v talk.Value) error {
					crossing(o.Value().String() + ":" + name + ":set")
					values.receive(v)
					o.Native().(map[string]talk.Value)[name] = v
					return nil
				}
			}
			for key, target := range map[string]*talk.Cost{"getCost": &prop.GetCost, "setCost": &prop.SetCost} {
				cost, _ := p[key].(Setup)
				target.Fuel, _ = cost["fuel"].(int64)
				target.Alloc, _ = cost["alloc"].(int64)
			}
			def.Props = append(def.Props, prop)
		}
		kind, err := core.DefineObjectKind(def)
		if err != nil {
			return nil, err
		}
		kinds[def.Name] = kind
	}
	objects := objectReplay{}
	values.objects = objects
	rows, _ = setup["objects"].([]any)
	var pending []Setup
	makeObject := func(row Setup, opts ...talk.ObjectOption) error {
		native := map[string]talk.Value{}
		props, _ := row["props"].(Setup)
		for name, display := range props {
			v, err := corevalue.ParseDisplay(display.(string), nil)
			if err != nil {
				return err
			}
			native[name], err = construct(v)
			if err != nil {
				return err
			}
		}
		ref := objectRef{row["kind"].(string), row["id"].(string)}
		o, err := group.Object(kinds[ref.kind], ref.id, native, opts...)
		if err != nil {
			return err
		}
		objects[ref] = o
		return nil
	}
	values.madeBy = func(operation string) error {
		rest := pending[:0]
		var due []Setup
		for _, row := range pending {
			if row["madeBy"] == operation {
				due = append(due, row)
			} else {
				rest = append(rest, row)
			}
		}
		pending = rest
		for _, row := range due {
			var opts []talk.ObjectOption
			if shown, ok := row["parent"].(string); ok {
				v, err := corevalue.ParseDisplay(shown, nil)
				if err != nil {
					return err
				}
				parent, err := values.construct(v)
				if err != nil {
					return err
				}
				o, ok := parent.AsObject()
				if !ok {
					return fmt.Errorf("parent %s is not an object", shown)
				}
				opts = append(opts, talk.WithParent(o))
			}
			if err := makeObject(row, opts...); err != nil {
				return err
			}
		}
		return nil
	}
	for _, raw := range rows {
		row := raw.(Setup)
		if _, ok := row["madeBy"]; ok {
			pending = append(pending, row)
			continue
		}
		if _, ok := row["parent"]; ok {
			return nil, fmt.Errorf("%v has a parent but no madeBy", row["id"])
		}
		if err := makeObject(row); err != nil {
			return nil, err
		}
	}
	if err := collections.members(setup, kinds, objects); err != nil {
		return nil, err
	}
	return objects, nil
}
func (objects objectReplay) bindings(setup Setup) (map[string]*talk.Object, error) {
	out := map[string]*talk.Object{}
	bindings, _ := setup["objects"].(Setup)
	for name, raw := range bindings {
		ref := raw.(Setup)
		o := objects[objectRef{ref["kind"].(string), ref["id"].(string)}]
		if o == nil {
			return nil, fmt.Errorf("unknown Object binding %s", name)
		}
		out[name] = o
	}
	return out, nil
}

func restoredObjects(group *talk.Group, before objectReplay) objectReplay {
	out := objectReplay{}
	for ref := range before {
		if o, ok := group.ObjectByID(ref.kind, ref.id); ok {
			out[ref] = o
		}
	}
	return out
}
