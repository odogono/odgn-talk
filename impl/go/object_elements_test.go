// The Zig reactor does not offer object-elements-v1 yet, so these run on the
// native Core only.

//go:build !talk_zig_experimental

package northtalk

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// Object Element References (#1143): the Host API and the result checks the
// corpus cannot reach, mirroring impl/ts/tests/object-elements.test.ts.

type elementTrace []string

func (t *elementTrace) Record(line string) { *t = append(*t, line) }

func elementCollection(cell *ObjectKind) ObjectElements {
	return ObjectElements{
		Shape:     ObjectShape(cell),
		Count:     func(*Object) (Value, error) { return Int(0), nil },
		At:        func(*Object, int64) (Value, error) { return Nothing, nil },
		Find:      func(*Object, string) (Value, error) { return Nothing, nil },
		CountCost: Cost{Fuel: 1},
		AtCost:    Cost{Fuel: 1},
		FindCost:  Cost{Fuel: 1},
	}
}

// runElements returns body's result for a page whose collection answers as
// change sets, with the Trace's lines. Members c1 and c2 are made first.
func runElements(t *testing.T, change func(e *ObjectElements, members []*Object), body string) (string, []string) {
	t.Helper()
	core := New()
	cell := objectKindForTest(t, core, "cell")
	var trace elementTrace
	g := core.NewGroup(GroupOptions{Name: "g", Trace: &trace})
	members := []*Object{}
	for _, id := range []string{"c1", "c2"} {
		o, err := g.Object(cell, id, nil)
		if err != nil {
			t.Fatal(err)
		}
		members = append(members, o)
	}
	elements := elementCollection(cell)
	change(&elements, members)
	page, err := core.DefineObjectKind(ObjectKindDef{Name: "page", Elements: &elements})
	if err != nil {
		t.Fatal(err)
	}
	main, err := g.Object(page, "main", nil)
	if err != nil {
		t.Fatal(err)
	}
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n" + body + "\nend go", Objects: map[string]*Object{"thisPage": main}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(time.Date(2026, 10, 17, 9, 0, 0, 0, time.UTC), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return joinEnd(t, result, "s").Result.String(), trace
}

const catchElement = " try\n  return %s\n catch e\n  return e\n end try"

func TestObjectElementsDefinition(t *testing.T) {
	core := New()
	cell := objectKindForTest(t, core, "cell")
	other := objectKindForTest(t, core, "other")
	for name, change := range map[string]func(*ObjectElements){
		"no Find":           func(e *ObjectElements) { e.Find = nil },
		"negative cost":     func(e *ObjectElements) { e.CountCost = Cost{Fuel: -1} },
		"too large cost":    func(e *ObjectElements) { e.AtCost = Cost{Alloc: 9007199254740992} },
		"text Shape":        func(e *ObjectElements) { e.Shape = TextShape },
		"value Shape":       func(e *ObjectElements) { e.Shape = ValueShape },
		"optional Shape":    func(e *ObjectElements) { e.Shape = Optional(ObjectShape(cell)) },
		"repeated choice":   func(e *ObjectElements) { e.Shape = OneOf(ObjectShape(cell), ObjectShape(cell)) },
		"empty choice":      func(e *ObjectElements) { e.Shape = OneOf() },
		"zero Shape":        func(e *ObjectElements) { e.Shape = Shape{} },
		"choice with value": func(e *ObjectElements) { e.Shape = OneOf(ObjectShape(cell), ValueShape) },
	} {
		elements := elementCollection(cell)
		change(&elements)
		_, err := core.DefineObjectKind(ObjectKindDef{Name: "page", Elements: &elements})
		var e *HostError
		if !errors.As(err, &e) || e.Code != InvalidValue {
			t.Errorf("%s: want invalid value, got %v", name, err)
		}
	}
	elements := elementCollection(cell)
	elements.Shape = OneOf(ObjectShape(cell), ObjectShape(other))
	elements.Count = func(*Object) (Value, error) { return Int(2), nil }
	kind, err := core.DefineObjectKind(ObjectKindDef{Name: "page", Elements: &elements})
	if err != nil {
		t.Fatal(err)
	}
	// Later changes to the definition do not change the declaration.
	elements.Count = func(*Object) (Value, error) { return Int(9), nil }
	elements.CountCost = Cost{Fuel: 100}
	if kind.elements.CountCost.Fuel != 1 {
		t.Fatal(kind.elements.CountCost)
	}
	if v, _ := kind.elements.Count(nil); v.String() != "2" {
		t.Fatal(v)
	}
}

func TestObjectElementsSignedPositionsAndNames(t *testing.T) {
	calls := []string{}
	result, trace := runElements(t, func(e *ObjectElements, members []*Object) {
		e.At = func(_ *Object, index int64) (Value, error) {
			calls = append(calls, "at "+Int(index).String())
			if index > 0 {
				return members[index-1].Value(), nil
			}
			return members[int64(len(members))+index].Value(), nil
		}
		e.Find = func(_ *Object, name string) (Value, error) {
			calls = append(calls, "find "+name)
			return Nothing, nil
		}
		e.Count = func(*Object) (Value, error) { calls = append(calls, "count"); return Int(2), nil }
	}, ` return [element -1 of thisPage, the first element of thisPage, element "Ä" of thisPage, element 0 of thisPage, the number of elements of thisPage]`)
	if strings.Join(calls, ",") != "at -1,at 1,find Ä,count" {
		t.Fatal(calls)
	}
	if result != `[<object cell "c2">, <object cell "c1">, nothing, nothing, 2]` {
		t.Fatal(result)
	}
	want := []string{
		`prop s/r1 object=<object page "main"> name=elements op=at selector=-1 value=<object cell "c2">`,
		`prop s/r1 object=<object page "main"> name=elements op=at selector=1 value=<object cell "c1">`,
		`prop s/r1 object=<object page "main"> name=elements op=find selector="Ä" value=nothing`,
		`prop s/r1 object=<object page "main"> name=elements op=count value=2`,
	}
	got := []string{}
	for _, line := range trace {
		if strings.HasPrefix(line, "prop ") {
			got = append(got, line)
		}
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("got\n%s", strings.Join(got, "\n"))
	}
}

func TestObjectElementsMalformedAnswers(t *testing.T) {
	for name, answer := range map[string]func([]*Object) (Value, error){
		"a number":      func([]*Object) (Value, error) { return Int(3), nil },
		"text":          func([]*Object) (Value, error) { return mustPublicText("x"), nil },
		"a Host error":  func([]*Object) (Value, error) { return Nothing, errors.New("broken") },
		"a Host panic":  func([]*Object) (Value, error) { panic("broken") },
		"a nil failure": func([]*Object) (Value, error) { return Nothing, (*ScriptError)(nil) },
	} {
		result, trace := runElements(t, func(e *ObjectElements, members []*Object) {
			e.At = func(*Object, int64) (Value, error) { return answer(members) }
		}, strings.Replace(catchElement, "%s", "element 1 of thisPage", 1))
		if !strings.Contains(result, `code: "host error"`) || !strings.Contains(result, `capability: "page", operation: "elements.at"`) {
			t.Errorf("%s: %s", name, result)
		}
		recorded := false
		for _, line := range trace {
			recorded = recorded || line == `prop s/r1 object=<object page "main"> name=elements op=at selector=1 error={}`
		}
		if !recorded {
			t.Errorf("%s: %v", name, trace)
		}
	}
}

func TestObjectElementsCountBound(t *testing.T) {
	for _, count := range []string{"-1", "1.5", `"2"`, "9007199254740992"} {
		result, _ := runElements(t, func(e *ObjectElements, _ []*Object) {
			e.Count = func(*Object) (Value, error) {
				if count == `"2"` {
					return mustPublicText("2"), nil
				}
				return Dec(count)
			}
		}, strings.Replace(catchElement, "%s", "the number of elements of thisPage", 1))
		if !strings.Contains(result, `code: "host error"`) || !strings.Contains(result, `operation: "elements.count"`) {
			t.Errorf("%s: %s", count, result)
		}
	}
	result, _ := runElements(t, func(e *ObjectElements, _ []*Object) {
		e.Count = func(*Object) (Value, error) { return Int(9007199254740991), nil }
	}, " return the number of elements of thisPage")
	if result != "9007199254740991" {
		t.Fatal(result)
	}
}

func TestObjectElementsDisposedAndForeignMembers(t *testing.T) {
	core := New()
	cell := objectKindForTest(t, core, "cell")
	foreign, err := core.NewGroup(GroupOptions{}).Object(cell, "x", nil)
	if err != nil {
		t.Fatal(err)
	}
	result, _ := runElements(t, func(e *ObjectElements, _ []*Object) {
		e.Find = func(*Object, string) (Value, error) { return foreign.Value(), nil }
	}, strings.Replace(catchElement, "%s", `element "x" of thisPage`, 1))
	if !strings.Contains(result, `code: "host error"`) {
		t.Fatal(result)
	}
	g := core.NewGroup(GroupOptions{})
	member, err := g.Object(cell, "gone", nil)
	if err != nil {
		t.Fatal(err)
	}
	elements := elementCollection(cell)
	elements.At = func(*Object, int64) (Value, error) { return member.Value(), nil }
	page, err := core.DefineObjectKind(ObjectKindDef{Name: "page", Elements: &elements})
	if err != nil {
		t.Fatal(err)
	}
	main, _ := g.Object(page, "main", nil)
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n" + strings.Replace(catchElement, "%s", "element 1 of thisPage", 1) + "\nend go", Objects: map[string]*Object{"thisPage": main}})
	if err != nil {
		t.Fatal(err)
	}
	if err = g.Dispose(member); err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	pumped, err := g.Pump(time.Date(2026, 10, 17, 9, 0, 0, 0, time.UTC), PumpOptions{})
	if err != nil || !strings.Contains(joinEnd(t, pumped, "s").Result.String(), `code: "host error"`) {
		t.Fatal(pumped, err)
	}
}

func TestObjectElementsScriptErrorNamesKindAndCallback(t *testing.T) {
	result, _ := runElements(t, func(e *ObjectElements, _ []*Object) {
		e.Count = func(*Object) (Value, error) {
			data, _ := Map(KV("page", mustPublicText("main")))
			return Nothing, &ScriptError{Code: "page locked", Message: "locked", Data: data}
		}
	}, strings.Replace(catchElement, "%s", "the number of elements of thisPage", 1))
	for _, want := range []string{`code: "page locked"`, `capability: "page"`, `operation: "elements.count"`} {
		if !strings.Contains(result, want) {
			t.Fatal(result)
		}
	}
}

func TestObjectElementsHugePositionsSelectNothing(t *testing.T) {
	calls := []int64{}
	result, _ := runElements(t, func(e *ObjectElements, _ []*Object) {
		e.At = func(_ *Object, index int64) (Value, error) { calls = append(calls, index); return Nothing, nil }
	}, " return [element 9007199254740992 of thisPage, element -9007199254740992 of thisPage, element 9007199254740991 of thisPage, element -9007199254740991 of thisPage]")
	if len(calls) != 2 || calls[0] != 9007199254740991 || calls[1] != -9007199254740991 {
		t.Fatal(calls)
	}
	if result != "[nothing, nothing, nothing, nothing]" {
		t.Fatal(result)
	}
}
