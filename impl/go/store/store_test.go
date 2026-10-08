package store_test

import (
	"reflect"
	"strings"
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

type traced []string

func (t *traced) Record(line string) {
	if strings.HasPrefix(line, "effect ") {
		*t = append(*t, line)
	}
}

// deliver runs go once in a Script with these Grants, giving its end and its
// effect Trace lines.
func deliver(t *testing.T, core *talk.Core, source string, grants map[string]*talk.Grant) (*talk.RunEnd, *talk.Group, []string) {
	t.Helper()
	lines := &traced{}
	g := core.NewGroup(talk.GroupOptions{Trace: lines})
	script, err := g.Load(talk.LoadOptions{Name: "s", Source: "script variable seen = nothing\n" + source, Grants: grants, Limits: talk.Limits{FuelPerRun: 400}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := script.Deliver(talk.Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	end := ended(t, g)
	return end, g, *lines
}
func TestMemoryStoresShareOneParticipant(t *testing.T) {
	core := talk.New()
	stores := store.New(store.SessionQuotas())
	def, err := core.StoreCapability(stores, costs())
	if err != nil {
		t.Fatal(err)
	}
	// A second factory over the same Stores maps to the same coordinator.
	again, err := core.StoreCapability(stores, costs())
	if err != nil {
		t.Fatal(err)
	}
	reader, err := def.Grant([]string{"get", "keys"}, "scores")
	if err != nil {
		t.Fatal(err)
	}
	grants := map[string]*talk.Grant{"reader": reader, "scores": def.GrantAll("scores"), "progress": def.GrantAll("progress"), "alias": again.GrantAll("scores")}
	end, g, effects := deliver(t, core, "on go\nask reader to get \"k\"\nask scores to increment \"total\", 5\nask progress to set \"level\", 2\nask alias to increment \"total\", 1\nask reader to get \"total\"\nput it into seen\nend go", grants)
	if end.Outcome != talk.Completed {
		t.Fatal(end.Error)
	}
	if got := g.Inspect().Scripts[0].Vars[0].Val.String(); got != "6" {
		t.Fatal("Read-only alias missed the Segment's writes", got)
	}
	if len(effects) != 2 || !strings.Contains(effects[0], "grant=scores phase=begin status=ok") || !strings.Contains(effects[1], "grant=scores phase=commit status=ok") {
		t.Fatal(effects)
	}
	if got := entries(stores, "scores"); !reflect.DeepEqual(got, []string{"total=6"}) {
		t.Fatal(got)
	}
	if got := entries(stores, "progress"); !reflect.DeepEqual(got, []string{"level=2"}) {
		t.Fatal(got)
	}
	// A Limit Fault rolls back the writes to both Stores.
	end, _, effects = deliver(t, core, "on go\nask scores to set \"total\", 0\nask progress to set \"level\", 0\nrepeat while true\nend repeat\nend go", grants)
	if end.Outcome != talk.LimitFault || len(effects) != 2 || !strings.Contains(effects[1], "grant=scores phase=rollback status=ok") {
		t.Fatal(end.Outcome, effects)
	}
	if got := append(entries(stores, "scores"), entries(stores, "progress")...); !reflect.DeepEqual(got, []string{"total=6", "level=2"}) {
		t.Fatal(got)
	}
}
func TestMemoryStoreConflictsWithAnotherCoordinator(t *testing.T) {
	core := talk.New()
	stores := store.New(store.SessionQuotas())
	def, err := core.StoreCapability(stores, costs())
	if err != nil {
		t.Fatal(err)
	}
	ok := func(talk.SegmentContext) talk.EffectResult { return talk.EffectResult{Status: talk.EffectOK} }
	other, err := core.DefineSegmentCapability("other", talk.SegmentLifecycle{Begin: ok, Commit: ok, Rollback: ok}, talk.Operation{Name: "write", Mode: talk.Immediate, Result: talk.NothingShape, SegmentBound: true, Do: func(*talk.Call, []talk.Value) (talk.Value, error) { return talk.Nothing, nil }})
	if err != nil {
		t.Fatal(err)
	}
	end, _, _ := deliver(t, core, "on go\nask o to write\nask s to set \"k\", 1\nend go", map[string]*talk.Grant{"o": other.GrantAll(nil), "s": def.GrantAll("one")})
	if end.Error == nil || end.Error.Code != "segment participant conflict" || end.Error.Data.Get("participant").String() != `"o"` {
		t.Fatal(end.Error)
	}
	if len(stores.Entries("one")) != 0 {
		t.Fatal("Conflicting write reached the Store")
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
