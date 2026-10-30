package corpus

import (
	"fmt"

	talk "northtalk.org/go"
	corevalue "northtalk.org/go/internal/value"
)

// collectionReplay answers Object Collection callbacks (#1143). A callback
// answers from its `prop` record when the Trace has one, as the TS runner
// does, and otherwise from the case's `[objects].elements` members. Members
// stay display Values, so a restored Group resolves its own handles.
type collectionReplay struct {
	values   *replayValues
	crossing func(string)
	records  map[string][]Record
	lists    map[string][]collectionMember
}

type collectionMember struct {
	name   string
	object corevalue.Value
}

func newCollectionReplay(values *replayValues, crossing func(string), records []Record) *collectionReplay {
	c := &collectionReplay{values: values, crossing: crossing, records: map[string][]Record{}, lists: map[string][]collectionMember{}}
	for _, r := range records {
		if r.Name != "prop" || r.Input {
			continue
		}
		key := crossingKey(r)
		c.records[key] = append(c.records[key], r)
	}
	return c
}

// declaration is a kind's `elements` from case.toml, with replay callbacks.
func (c *collectionReplay) declaration(row Setup, kinds map[string]*talk.ObjectKind) (*talk.ObjectElements, error) {
	shape, err := collectionShape(row["shape"], kinds)
	if err != nil {
		return nil, err
	}
	e := &talk.ObjectElements{
		Shape: shape,
		Count: func(o *talk.Object) (talk.Value, error) {
			return c.call(o, "count", nil, func(list []collectionMember) (talk.Value, error) {
				return talk.Int(int64(len(list))), nil
			})
		},
		At: func(o *talk.Object, index int64) (talk.Value, error) {
			return c.call(o, "at", func(v corevalue.Value) bool {
				n, err := v.Number().Int64()
				return v.Kind == corevalue.Number && err == nil && n == index
			}, func(list []collectionMember) (talk.Value, error) {
				i := index - 1
				if index < 0 {
					i = int64(len(list)) + index
				}
				if i < 0 || i >= int64(len(list)) {
					return talk.Nothing, nil
				}
				return c.values.construct(list[i].object)
			})
		},
		Find: func(o *talk.Object, name string) (talk.Value, error) {
			return c.call(o, "find", func(v corevalue.Value) bool {
				return v.Kind == corevalue.Text && v.Text() == name
			}, func(list []collectionMember) (talk.Value, error) {
				for _, m := range list {
					if m.name == name {
						return c.values.construct(m.object)
					}
				}
				return talk.Nothing, nil
			})
		},
	}
	for key, target := range map[string]*talk.Cost{"countCost": &e.CountCost, "atCost": &e.AtCost, "findCost": &e.FindCost} {
		cost, _ := row[key].(Setup)
		target.Fuel, _ = cost["fuel"].(int64)
		target.Alloc, _ = cost["alloc"].(int64)
	}
	return e, nil
}

// collectionShape reads an Object Shape or a OneOf of them.
func collectionShape(raw any, kinds map[string]*talk.ObjectKind) (talk.Shape, error) {
	m, _ := raw.(Setup)
	if name, ok := m["object"].(string); ok {
		kind := kinds[name]
		if kind == nil {
			return talk.Shape{}, fmt.Errorf("unknown Object Kind %s", name)
		}
		return talk.ObjectShape(kind), nil
	}
	if xs, ok := m["oneOf"].([]any); ok {
		var ss []talk.Shape
		for _, x := range xs {
			s, err := collectionShape(x, kinds)
			if err != nil {
				return s, err
			}
			ss = append(ss, s)
		}
		return talk.OneOf(ss...), nil
	}
	return talk.Shape{}, fmt.Errorf("unsupported Object Collection Shape %v", raw)
}

func (c *collectionReplay) call(o *talk.Object, op string, selector func(corevalue.Value) bool, live func([]collectionMember) (talk.Value, error)) (talk.Value, error) {
	key := o.Value().String() + ":elements:" + op
	c.crossing(key)
	if queue := c.records[key]; len(queue) > 0 {
		r := queue[0]
		c.records[key] = queue[1:]
		fields := map[string]Field{}
		for _, f := range r.Fields {
			fields[f.Key] = f
		}
		recorded, has := fields["selector"]
		if has != (selector != nil) || has && !selector(recorded.Value) {
			return talk.Nothing, fmt.Errorf("the recorded collection call has selector %q", recorded.Raw)
		}
		if failed, ok := fields["error"]; ok {
			return talk.Nothing, c.failure(failed.Value)
		}
		if v, ok := fields["value"]; ok {
			return c.values.construct(v.Value)
		}
		return talk.Nothing, nil
	}
	return live(c.lists[o.Value().String()])
}

// failure is the ScriptError a recorded `error` stands for; an empty map is
// a malformed failure.
func (c *collectionReplay) failure(v corevalue.Value) error {
	code := v.Get("code")
	if code.Kind != corevalue.Text {
		return fmt.Errorf("the recorded collection call fails")
	}
	var entries []talk.Pair
	for _, p := range v.Entries() {
		if p.Key != "code" && p.Key != "message" {
			x, err := c.values.construct(p.Val)
			if err != nil {
				return err
			}
			entries = append(entries, talk.KV(p.Key, x))
		}
	}
	data, _ := talk.Map(entries...)
	return &talk.ScriptError{Code: code.Text(), Message: v.Get("message").Text(), Data: data}
}

// members resolves each `[objects].elements` list after every setup handle
// exists, rejecting duplicate names, unknown members and kinds without a
// collection.
func (c *collectionReplay) members(setup Setup, kinds map[string]*talk.ObjectKind, objects objectReplay) error {
	rows, _ := setup["objects"].([]any)
	declared := map[string]bool{}
	kindRows, _ := setup["objectKinds"].([]any)
	for _, raw := range kindRows {
		row := raw.(Setup)
		_, declared[row["name"].(string)] = row["elements"].(Setup)
	}
	for _, raw := range rows {
		row := raw.(Setup)
		list, ok := row["elements"].([]any)
		if !ok {
			continue
		}
		ref := objectRef{row["kind"].(string), row["id"].(string)}
		if !declared[ref.kind] {
			return fmt.Errorf("Object Kind %s has no collection", ref.kind)
		}
		names := map[string]bool{}
		for _, raw := range list {
			m := raw.(Setup)
			name, _ := m["name"].(string)
			display, _ := m["object"].(string)
			if names[name] {
				return fmt.Errorf("duplicate collection member name %s", name)
			}
			names[name] = true
			v, err := corevalue.ParseDisplay(display, nil)
			if err != nil {
				return err
			}
			if v.Kind != corevalue.Object || v.Object() == nil || objects[objectRef{v.Object().Kind, v.Object().ID}] == nil {
				return fmt.Errorf("unknown collection member %s", display)
			}
			key := objects[ref].Value().String()
			c.lists[key] = append(c.lists[key], collectionMember{name: name, object: v})
		}
	}
	_ = kinds
	return nil
}
