package store_test

import (
	"reflect"
	"sync"
	"testing"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/store"
)

func costs() talk.Costs {
	return talk.Costs{"get": {Fuel: 2}, "keys": {Fuel: 2}, "set": {Fuel: 4}, "delete": {Fuel: 4}, "increment": {Fuel: 4}, "swap": {Fuel: 4}}
}
func ended(t *testing.T, g *talk.Group) *talk.RunEnd {
	t.Helper()
	result, err := g.Pump(time.Unix(0, 0), talk.PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range result.Reports {
		if end, ok := r.(*talk.RunEnd); ok {
			return end
		}
	}
	t.Fatal("No RunEnd")
	return nil
}
func entries(s *store.Stores, name string) []string {
	out := []string{}
	for _, p := range s.Entries(name) {
		out = append(out, p.Key+"="+p.Val.String())
	}
	return out
}
func TestMemoryStoreAcrossGroupsAndReservations(t *testing.T) {
	stores := store.New(store.SessionQuotas())
	core := talk.New()
	def, err := core.StoreCapability(stores, costs())
	if err != nil {
		t.Fatal(err)
	}
	groups := []*talk.Group{}
	for range 2 {
		g := core.NewGroup(talk.GroupOptions{})
		script, err := g.Load(talk.LoadOptions{Name: "s", Source: "on go\nask st to set \"k\", 1\nrepeat 200 times\nend repeat\nend go", Grants: map[string]*talk.Grant{"st": def.GrantAll("shared")}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := script.Deliver(talk.Message{Name: "go"}); err != nil {
			t.Fatal(err)
		}
		groups = append(groups, g)
	}
	first, err := groups[0].Pump(time.Unix(0, 0), talk.PumpOptions{FuelSlice: 40, FuelCap: 40})
	if err != nil {
		t.Fatal(err)
	}
	if first.State != talk.Sliced || len(stores.Entries("shared")) != 0 {
		t.Fatal("Expected an uncommitted write", first)
	}
	busy := ended(t, groups[1])
	if busy.Error == nil || busy.Error.Code != "store busy" {
		t.Fatal("Group identity conflated", busy.Error)
	}
	if end := ended(t, groups[0]); end.Outcome != talk.Completed {
		t.Fatal(end.Error)
	}
	if got := entries(stores, "shared"); !reflect.DeepEqual(got, []string{"k=1"}) {
		t.Fatal(got)
	}
}
func TestMemoryStoreAcrossConcurrentGroups(t *testing.T) {
	stores := store.New(store.SessionQuotas())
	core := talk.New()
	def, err := core.StoreCapability(stores, costs())
	if err != nil {
		t.Fatal(err)
	}
	const count = 12
	groups := []*talk.Group{}
	for range count {
		group := core.NewGroup(talk.GroupOptions{})
		script, err := group.Load(talk.LoadOptions{Name: "s", Source: "on go\nask st to increment \"count\"\nrepeat 50 times\nend repeat\nend go", Grants: map[string]*talk.Grant{"st": def.GrantAll("shared")}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := script.Deliver(talk.Message{Name: "go"}); err != nil {
			t.Fatal(err)
		}
		if _, err := group.Pump(time.Unix(0, 0), talk.PumpOptions{FuelSlice: 40, FuelCap: 40}); err != nil {
			t.Fatal(err)
		}
		groups = append(groups, group)
	}
	var wait sync.WaitGroup
	for _, group := range groups {
		wait.Add(1)
		go func() {
			defer wait.Done()
			result, err := group.Pump(time.Unix(0, 0), talk.PumpOptions{})
			if err != nil {
				t.Error(err)
				return
			}
			for _, r := range result.Reports {
				if end, ok := r.(*talk.RunEnd); ok && end.Outcome != talk.Completed {
					t.Errorf("%v", end.Error)
				}
			}
		}()
	}
	wait.Wait()
	if got := entries(stores, "shared"); !reflect.DeepEqual(got, []string{"count=12"}) {
		t.Fatal(got)
	}
}
func TestMemoryStoreObjectsAndFunctions(t *testing.T) {
	core := talk.New()
	stores := store.New(store.SessionQuotas())
	def, err := core.StoreCapability(stores, costs())
	if err != nil {
		t.Fatal(err)
	}
	kind, err := core.DefineObjectKind(talk.ObjectKindDef{Name: "room"})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ source, code string }{
		{"on go r\nask st to set \"k\", {at: [r]}\nend go", "can't store"},
		{"on go r\nask st to swap \"k\", 1, {at: [r]}\nend go", "can't store"},
		{"function f n\nreturn n\nend f\non go r\nask st to set \"k\", [f]\nend go", "not encodable"},
	} {
		g := core.NewGroup(talk.GroupOptions{})
		object, err := g.Object(kind, "r1", nil)
		if err != nil {
			t.Fatal(err)
		}
		script, err := g.Load(talk.LoadOptions{Name: "s", Source: test.source, Grants: map[string]*talk.Grant{"st": def.GrantAll("default")}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := script.Deliver(talk.Message{Name: "go", Args: []talk.Value{object.Value()}}); err != nil {
			t.Fatal(err)
		}
		end := ended(t, g)
		if end.Error == nil || end.Error.Code != test.code {
			t.Fatal(end.Error)
		}
		if test.code == "can't store" && end.Error.Data.Get("kind").String() != `"room"` {
			t.Fatal(end.Error.Data)
		}
		if len(stores.Entries("default")) != 0 {
			t.Fatal("Refused write changed the Store")
		}
	}
}
func TestMemoryStoreReaderSharesOwnWritesAndSecondWriterConflicts(t *testing.T) {
	core := talk.New()
	stores := store.New(store.SessionQuotas())
	def, err := core.StoreCapability(stores, costs())
	if err != nil {
		t.Fatal(err)
	}
	reader, err := def.Grant([]string{"get", "keys"}, "one")
	if err != nil {
		t.Fatal(err)
	}
	g := core.NewGroup(talk.GroupOptions{})
	script, err := g.Load(talk.LoadOptions{Name: "s", Source: "script variable seen = nothing\non go\nask reader to get \"k\"\nask a to set \"k\", 1\nask reader to get \"k\"\nput it into seen\nask b to set \"k\", 2\nend go", Grants: map[string]*talk.Grant{"reader": reader, "a": def.GrantAll("one"), "b": def.GrantAll("two")}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := script.Deliver(talk.Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	end := ended(t, g)
	if end.Error == nil || end.Error.Code != "segment participant conflict" {
		t.Fatal(end.Error)
	}
	if got := g.Inspect().Scripts[0].Vars[0].Val.String(); got != "1" {
		t.Fatal("Read-only alias missed the Segment's write", got)
	}
	if got := entries(stores, "one"); !reflect.DeepEqual(got, []string{"k=1"}) {
		t.Fatal(got)
	}
	if len(stores.Entries("two")) != 0 {
		t.Fatal("Second participant wrote")
	}
}
func TestMemoryStoreReplaceValidationAndAtomicity(t *testing.T) {
	stores := store.New(store.Quotas{Size: 100, Keys: 2, Value: 20})
	text := func(s string) talk.Value {
		v, err := talk.Text(s)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	if err := stores.Replace("s", []talk.Pair{talk.KV("a", talk.Int(1)), talk.KV("b", talk.Nothing)}); err != nil {
		t.Fatal(err)
	}
	for _, next := range [][]talk.Pair{
		{talk.KV("", talk.Int(1))},
		{talk.KV("a", talk.Int(1)), talk.KV("a", talk.Int(2))},
		{talk.KV("a", text("a long value of text"))},
		{talk.KV("a", talk.Int(1)), talk.KV("b", talk.Int(1)), talk.KV("c", talk.Int(1))},
		{talk.KV("e\u0301", talk.Int(1)), talk.KV("é", talk.Int(2))},
	} {
		if err := stores.Replace("s", next); err == nil {
			t.Fatal("Accepted", next)
		}
		if got := entries(stores, "s"); !reflect.DeepEqual(got, []string{"a=1"}) {
			t.Fatal("Invalid replacement changed contents", got)
		}
	}
	if err := stores.Clear("s"); err != nil {
		t.Fatal(err)
	}
	if len(stores.Entries("s")) != 0 {
		t.Fatal("Clear failed")
	}
}
