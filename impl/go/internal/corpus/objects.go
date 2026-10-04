package corpus

import (
	"fmt"

	talk "github.com/odogono/odgn-talk/impl/go"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

type objectRef struct{ kind, id string }
type objectReplay map[objectRef]*talk.Object

func setupObjects(core *talk.Core, group *talk.Group, setup Setup) (objectReplay, error) {
	kinds := map[string]*talk.ObjectKind{}
	rows, _ := setup["objectKinds"].([]any)
	for _, raw := range rows {
		row := raw.(Setup)
		def := talk.ObjectKindDef{Name: row["name"].(string)}
		parents, _ := row["parentKinds"].([]any)
		for _, parent := range parents {
			def.ParentKinds = append(def.ParentKinds, parent.(string))
		}
		props, _ := row["props"].([]any)
		for _, raw := range props {
			p := raw.(Setup)
			shape, err := setupShape(p["shape"])
			if err != nil {
				return nil, err
			}
			name := p["name"].(string)
			prop := talk.Prop{Name: name, Shape: shape, Get: func(o *talk.Object) (talk.Value, error) { return o.Native().(map[string]talk.Value)[name], nil }}
			if p["readOnly"] != true {
				prop.Set = func(o *talk.Object, v talk.Value) error { o.Native().(map[string]talk.Value)[name] = v; return nil }
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
	rows, _ = setup["objects"].([]any)
	for _, raw := range rows {
		row := raw.(Setup)
		native := map[string]talk.Value{}
		props, _ := row["props"].(Setup)
		for name, display := range props {
			v, err := corevalue.ParseDisplay(display.(string), nil)
			if err != nil {
				return nil, err
			}
			native[name], err = construct(v)
			if err != nil {
				return nil, err
			}
		}
		ref := objectRef{row["kind"].(string), row["id"].(string)}
		o, err := group.Object(kinds[ref.kind], ref.id, native)
		if err != nil {
			return nil, err
		}
		objects[ref] = o
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
