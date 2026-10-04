package northtalk

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

func objectKindForTest(t *testing.T, core *Core, name string) *ObjectKind {
	t.Helper()
	k, err := core.DefineObjectKind(ObjectKindDef{Name: name})
	if err != nil {
		t.Fatal(err)
	}
	return k
}
func hostCode(t *testing.T, err error, want HostErrorCode) {
	t.Helper()
	var e *HostError
	if !errors.As(err, &e) || e.Code != want {
		t.Fatalf("want %s, got %v", want, err)
	}
}

func TestObjectDefinitionsAndRegistration(t *testing.T) {
	core := New()
	prop := Prop{Name: "label", Shape: TextShape, Get: func(*Object) (Value, error) { return mustPublicText("item"), nil }}
	for _, def := range []ObjectKindDef{
		{}, {Name: "\xff"}, {Name: "item", Props: []Prop{{Name: "label", Shape: TextShape}}},
		{Name: "item", Props: []Prop{{Name: "", Shape: TextShape, Get: prop.Get}}},
		{Name: "item", Props: []Prop{prop, prop}},
		{Name: "item", Props: []Prop{{Name: "label", Get: prop.Get}}},
		{Name: "item", Props: []Prop{{Name: "label", Shape: TextShape, Get: prop.Get, GetCost: Cost{Fuel: -1}}}},
		{Name: "item", Props: []Prop{{Name: "label", Shape: TextShape, Get: prop.Get, SetCost: Cost{Alloc: 9007199254740992}}}},
	} {
		_, err := core.DefineObjectKind(def)
		hostCode(t, err, InvalidValue)
	}
	definition := ObjectKindDef{Name: "item", Props: []Prop{prop}, ParentKinds: []string{"container"}}
	kind, err := core.DefineObjectKind(definition)
	if err != nil {
		t.Fatal(err)
	}
	definition.Name = "changed"
	definition.Props[0].Name = "changed"
	definition.ParentKinds[0] = "changed"
	g := core.NewGroup(GroupOptions{})
	native := &struct{ label string }{"key"}
	o, err := g.Object(kind, "same", native)
	if err != nil || o.ID() != "same" || o.Kind() != kind || o.Native() != native {
		t.Fatal(o, err)
	}
	if o.Value().String() != `<object item "same">` {
		t.Fatal(o.Value())
	}
	if got, ok := o.Value().AsObject(); !ok || got != o {
		t.Fatal(got, ok)
	}
	_, err = g.Object(kind, "same", nil)
	hostCode(t, err, DuplicateObjectID)
	otherKind := objectKindForTest(t, core, "door")
	other, err := g.Object(otherKind, "same", nil)
	if err != nil || other.Value().Equal(o.Value()) {
		t.Fatal(other, err)
	}
	otherGroup := core.NewGroup(GroupOptions{})
	foreign, err := otherGroup.Object(kind, "same", nil)
	if err != nil || foreign.Value().Equal(o.Value()) {
		t.Fatal(foreign, err)
	}
	for _, id := range []string{"\xff"} {
		_, err = g.Object(kind, id, nil)
		hostCode(t, err, InvalidValue)
	}
	_, err = g.Object(nil, "nil", nil)
	hostCode(t, err, InvalidValue)
	encoded, err := EncodeValue(o.Value())
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeValue(encoded, func(name, id string) (*Object, bool) { return o, name == "item" && id == "same" })
	if err != nil || !decoded.Equal(o.Value()) {
		t.Fatal(decoded, err)
	}
}

func TestObjectBindingsDisposalAndReload(t *testing.T) {
	core := New()
	g := core.NewGroup(GroupOptions{})
	o, err := g.Object(objectKindForTest(t, core, "item"), "key", nil)
	if err != nil {
		t.Fatal(err)
	}
	bindings := map[string]*Object{"key": o}
	source := `script variable held = nothing
on go where objectKind(key) is "item"
 put key into held
 return [objectKind(held), the id of key, isDisposed(key), held = key]
end go`
	s, err := g.Load(LoadOptions{Name: "s", Source: source, Objects: bindings})
	if err != nil {
		t.Fatal(err)
	}
	delete(bindings, "key")
	now := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	if _, err = s.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	result, err := g.Pump(now, PumpOptions{})
	if err != nil || joinEnd(t, result, "s").Result.String() != `["item", "key", false, true]` {
		t.Fatal(result, err)
	}
	if err = g.Dispose(o); err != nil {
		t.Fatal(err)
	}
	// Disposal remains queued until the next Pump; equality and encoding survive.
	if _, err = s.Deliver(Message{Name: "go", Args: nil}); err != nil {
		t.Fatal(err)
	}
	result, err = g.Pump(now, PumpOptions{})
	if err != nil || joinEnd(t, result, "s").Result.String() != `["item", "key", true, true]` {
		t.Fatal(result, err)
	}
	if _, err = s.Reload(source, CarryVariables); err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	result, err = g.Pump(now, PumpOptions{})
	if err != nil || joinEnd(t, result, "s").Result.String() != `["item", "key", true, true]` {
		t.Fatal(result, err)
	}
	_, err = g.Object(o.Kind(), o.ID(), nil)
	hostCode(t, err, DuplicateObjectID)
	if err = g.Dispose(o); err != nil {
		t.Fatal(err)
	}
	if _, err = g.Pump(now, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
}

func TestObjectForeignAndNestedValuesAreRefused(t *testing.T) {
	core := New()
	g := core.NewGroup(GroupOptions{})
	foreign, err := core.NewGroup(GroupOptions{}).Object(objectKindForTest(t, core, "item"), "foreign", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, object := range []*Object{foreign, nil, {}} {
		_, err := g.Load(LoadOptions{Name: "rejected", Source: "on go\nend go", Objects: map[string]*Object{"key": object}})
		hostCode(t, err, WrongGroup)
		hostCode(t, g.Dispose(object), WrongGroup)
	}
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go x\n return x\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	for _, arg := range []Value{foreign.Value(), List(foreign.Value()), localeMap(t, KV("key", foreign.Value()))} {
		_, err = s.Deliver(Message{Name: "go", Args: []Value{arg}})
		hostCode(t, err, WrongGroup)
	}
	o, err := g.Object(foreign.Kind(), foreign.ID(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Deliver(Message{Name: "go", Args: []Value{List(o.Value())}}); err != nil {
		t.Fatal(err)
	}
	if _, err = g.Pump(time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
}

func TestObjectRegistrationAndDisposalFromHostCallback(t *testing.T) {
	core := New()
	kind := objectKindForTest(t, core, "item")
	var trace lines
	g := core.NewGroup(GroupOptions{Trace: &trace})
	var o *Object
	def, err := core.DefineCapability("host", Operation{Name: "make", Mode: Immediate, Result: ObjectShape(kind), Do: func(c *Call, _ []Value) (Value, error) {
		var err error
		o, err = c.Group().Object(kind, "key", nil)
		if err != nil {
			return Nothing, err
		}
		if err = c.Group().Dispose(o); err != nil {
			return Nothing, err
		}
		return o.Value(), nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	s, err := g.Load(LoadOptions{Name: "s", Source: "script variable held = nothing\non go\n ask host to make\n put it into held\n return isDisposed(held)\nend go\non later\n return isDisposed(held)\nend later", Grants: map[string]*Grant{"host": def.GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	now := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	result, err := g.Pump(now, PumpOptions{})
	if err != nil || joinEnd(t, result, "s").Result.String() != "false" {
		t.Fatal(result, err)
	}
	s.Deliver(Message{Name: "later"})
	result, err = g.Pump(now, PumpOptions{})
	if err != nil || joinEnd(t, result, "s").Result.String() != "true" || !strings.Contains(strings.Join(trace, "\n"), `> dispose object=<object item "key">`) {
		t.Fatal(result, err, trace)
	}
}

func TestObjectRegistrationIsSafeAcrossGoroutines(t *testing.T) {
	core := New()
	g := core.NewGroup(GroupOptions{})
	kind := objectKindForTest(t, core, "item")
	var wg sync.WaitGroup
	results := make(chan error, 16)
	for range 16 {
		wg.Go(func() { _, err := g.Object(kind, "same", nil); results <- err })
	}
	wg.Wait()
	close(results)
	created := 0
	for err := range results {
		if err == nil {
			created++
		} else {
			hostCode(t, err, DuplicateObjectID)
		}
	}
	if created != 1 {
		t.Fatal(created)
	}
}

func TestObjectDisposalNotifiesOnReadyAfterUnlocking(t *testing.T) {
	core := New()
	kind := objectKindForTest(t, core, "item")
	var group *Group
	notifications := 0
	group = core.NewGroup(GroupOptions{OnReady: func() {
		notifications++
		// Reenter an any-goroutine API: the notification must not hold the lock.
		if _, err := group.Object(kind, string(rune('a'+notifications)), nil); err != nil {
			t.Fatal(err)
		}
	}})
	o, err := group.Object(kind, "key", nil)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err = group.Dispose(o); err != nil {
			t.Fatal(err)
		}
	}
	if notifications != 2 {
		t.Fatalf("queued disposal notifications: got %d, want 2", notifications)
	}
	hostCode(t, group.Dispose(nil), WrongGroup)
	if notifications != 2 {
		t.Fatal("refused disposal notified OnReady")
	}
}
