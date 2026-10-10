package northtalk

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func TestSaveRestoresPreemptedSegment(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	s, e := g.Load(LoadOptions{Name: "s", Source: "script variable n = 0\non spin\n add 1 to n\n repeat forever\n end repeat\nend spin", Limits: Limits{FuelPerRun: 100}})
	if e != nil {
		t.Fatal(e)
	}
	s.Deliver(Message{Name: "spin"})
	g.Pump(time.Unix(1, 0), PumpOptions{FuelSlice: 20})
	saved, e := g.Save()
	if e != nil {
		t.Fatal(e)
	}
	restored, result, e := New().Restore(saved, RestoreOptions{})
	if e != nil {
		t.Fatal(e)
	}
	if len(result.Pending) != 0 {
		t.Fatal(result)
	}
	r, e := restored.Pump(time.Unix(2, 0), PumpOptions{})
	if e != nil {
		t.Fatal(e)
	}
	if r.FuelUsed != 80 {
		t.Fatalf("remaining Fuel %d", r.FuelUsed)
	}
	if got := restored.Inspect().Scripts[0].Vars[0].Val.String(); got != "0" {
		t.Fatalf("rollback n = %s", got)
	}
	// Saving changes only the save counter; restore then save yields the same bytes.
	a, _ := g.Save()
	clone, _, e := New().Restore(saved, RestoreOptions{})
	if e != nil {
		t.Fatal(e)
	}
	b, _ := clone.Save()
	if !bytes.Equal(a, b) {
		t.Fatal("snapshot is not deterministic")
	}
}

func TestRestorePreemptedOpenJoin(t *testing.T) {
	for _, reissue := range []bool{false, true} {
		t.Run(fmt.Sprint(reissue), func(t *testing.T) {
			c := New()
			def, err := c.DefineCapability("api", Operation{Name: "fetch", Mode: Suspending, Result: NumberShape, Cost: Cost{Fuel: 7}, Start: func(call *Call, args []Value) error {
				if reissue && call.Now().Unix() == 2 {
					return call.Charge(10000)
				}
				return nil
			}})
			if err != nil {
				t.Fatal(err)
			}
			grant := def.GrantAll(nil)
			g := c.NewGroup(GroupOptions{})
			s, err := g.Load(LoadOptions{Name: "s", Limits: Limits{FuelPerRun: 1000}, Grants: map[string]*Grant{"api": grant}, Source: "script variable n = 0\non go\n add 1 to n\n wait for all\n  ask api to fetch and wait\n  add 2 to n\n end wait\nend go"})
			if err != nil {
				t.Fatal(err)
			}
			s.Deliver(Message{Name: "go"})
			g.Pump(time.Unix(1, 0), PumpOptions{FuelSlice: 40})
			saved, err := g.Save()
			if err != nil {
				t.Fatal(err)
			}
			g, result, err := c.Restore(saved, RestoreOptions{Grants: func(string, string) *Grant { return grant }})
			if err != nil {
				t.Fatal(err)
			}
			if len(result.Pending) != 1 {
				t.Fatal(result.Pending)
			}
			if reissue {
				if _, err = g.Settle(result.Pending[0].ID, Settlement{Reissue: true}); err != nil {
					t.Fatal(err)
				}
			}
			pumped, err := g.Pump(time.Unix(2, 0), PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			ends := []*RunEnd{}
			for _, report := range operationalReports(pumped.Reports) {
				if end, ok := report.(*RunEnd); ok {
					ends = append(ends, end)
				}
			}
			var accounting *RunAccounting
			for _, report := range pumped.Reports {
				if r, ok := report.(*RunAccounting); ok {
					accounting = r
				}
			}
			if accounting == nil || accounting.State != "terminal" || len(ends) != 1 || accounting.Fuel != ends[0].Fuel {
				t.Fatal("lost restored Fuel", accounting, ends)
			}
			if len(ends) != 1 {
				t.Fatalf("Run ends %d", len(ends))
			}
			if reissue {
				if ends[0].Outcome != LimitFault {
					t.Fatal(ends[0])
				}
				if got := g.Inspect().Scripts[0].Vars[0].Val.String(); got != "0" {
					t.Fatalf("rollback n=%s", got)
				}
			} else {
				if ends[0].Error == nil || ends[0].Error.Code != "call lost" {
					t.Fatalf("lost call error %#v", ends[0].Error)
				}
			}
		})
	}
}

func TestRestoreRejectsMalformedFrames(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	s, e := g.Load(LoadOptions{Name: "s", Source: "on spin\n repeat forever\n end repeat\nend spin"})
	if e != nil {
		t.Fatal(e)
	}
	s.Deliver(Message{Name: "spin"})
	g.Pump(time.Unix(1, 0), PumpOptions{FuelSlice: 10})
	saved, e := g.Save()
	if e != nil {
		t.Fatal(e)
	}
	for _, name := range []string{"no frames", "missing locals", "past code", "invalid status", "null fuel", "bad value"} {
		t.Run(name, func(t *testing.T) {
			broken := rewriteSave(t, saved, func(data map[string]any) {
				script := data["Scripts"].([]any)[0].(map[string]any)
				run := script["Runs"].([]any)[0].(map[string]any)["Run"].(map[string]any)
				frame := run["Frames"].([]any)[0].(map[string]any)
				switch name {
				case "no frames":
					run["Frames"] = nil
				case "missing locals":
					frame["Locals"] = nil
				case "past code":
					frame["PC"] = len(s.runs[0].run.Frames[0].Code.Unit.Bodies[s.runs[0].run.Frames[0].Body].Code)
				case "invalid status":
					run["Status"] = 999
				case "null fuel":
					run["Fuel"] = nil
				case "bad value":
					run["Result"].(map[string]any)["Kind"] = 999
				}
			})
			_, _, err := c.Restore(broken, RestoreOptions{})
			host, ok := err.(*HostError)
			if !ok || host.Code != InvalidSave {
				t.Fatalf("malformed save accepted: %v", err)
			}
		})
	}
}
func rewriteSave(t *testing.T, save []byte, change func(map[string]any)) []byte {
	t.Helper()
	var outer struct{ Hash, Payload string }
	if err := json.Unmarshal(save, &outer); err != nil {
		t.Fatal(err)
	}
	var data map[string]any
	if err := json.Unmarshal([]byte(outer.Payload), &data); err != nil {
		t.Fatal(err)
	}
	change(data)
	b, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	outer.Payload = string(b)
	outer.Hash = fmt.Sprintf("%x", sha256.Sum256(b))
	b, err = json.Marshal(outer)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestRestorePendingSettlementsAndObjectIdentity(t *testing.T) {
	c := New()
	kind, e := c.DefineObjectKind(ObjectKindDef{Name: "thing"})
	if e != nil {
		t.Fatal(e)
	}
	var originalCall *Call
	def, e := c.DefineCapability("Api", Operation{Name: "fetch", Mode: Suspending, Result: NumberShape, Start: func(call *Call, args []Value) error { originalCall = call; return nil }})
	if e != nil {
		t.Fatal(e)
	}
	grant := def.GrantAll(nil)
	g := c.NewGroup(GroupOptions{})
	object, _ := g.Object(kind, "id", 42)
	s, e := g.Load(LoadOptions{Name: "s", Source: "script variable n = 0\nscript variable obj = nothing\non go\n put item into obj\n ask api to fetch and wait\n put it into n\nend go", Grants: map[string]*Grant{"api": grant}, Objects: map[string]*Object{"item": object}})
	if e != nil {
		t.Fatal(e)
	}
	s.Deliver(Message{Name: "go"})
	g.Pump(time.Unix(1, 0), PumpOptions{})
	saved, _ := g.Save()
	restored, result, e := c.Restore(saved, RestoreOptions{Grants: func(string, string) *Grant { return grant }, Resolve: func(kind, id string) (any, bool) { return 42, true }})
	if e != nil {
		t.Fatal(e)
	}
	call, e := restored.Settle(result.Pending[0].ID, Settlement{Adopt: true})
	if e != nil {
		t.Fatal(e)
	}
	if call == originalCall || call.Group() != restored {
		t.Fatal("adopt returned old Host Call")
	}
	if _, e = restored.Settle(call.ID(), Settlement{Adopt: true}); e == nil {
		t.Fatal("settled twice")
	}
	call.Answer(Int(7))
	restored.Pump(time.Unix(2, 0), PumpOptions{})
	view := restored.Inspect().Scripts[0]
	if view.Vars[0].Val.String() != "7" {
		t.Fatal(view.Vars)
	}
	got, _ := view.Vars[1].Val.AsObject()
	if got == object || got.ID() != "id" || got.Native() != 42 {
		t.Fatal("Object identity/binding did not roundtrip")
	}
	if _, e = restored.Settle(call.ID(), Settlement{Adopt: true}); e == nil {
		t.Fatal("settled after first Pump")
	}
}

func TestVariablesOnlyUsesRollbackBaseAndReportsScriptCall(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "a", Source: "script variable n = 0\non go\n add 1 to n\n wait for all\n  send slow to b and wait\n  add 2 to n\n end wait\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = g.Load(LoadOptions{Name: "b", Source: "on slow\n wait 1 s\nend slow"})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	g.Pump(time.Unix(1, 0), PumpOptions{FuelSlice: 40})
	saved, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	saved = rewriteSave(t, saved, func(data map[string]any) { data["Versions"].(map[string]any)["CostModel"] = "old" })
	restored, result, err := c.Restore(saved, RestoreOptions{Mismatch: VariablesOnly})
	if err != nil {
		t.Fatal(err)
	}
	if !result.VariablesOnly || len(result.AbandonedCalls) != 1 || result.AbandonedCalls[0] != "a/r1.c1" {
		t.Fatalf("abandoned Script call: %#v", result)
	}
	if got := restored.Inspect().Scripts[0].Vars[0].Val.String(); got != "0" {
		t.Fatalf("provisional value carried: %s", got)
	}
}

func TestFingerprintStringEscapes(t *testing.T) {
	got := string(fingerprintJSON(struct {
		Text string `json:"text"`
	}{"\b\t\n\f\r\x00\\\"<&\u2028\u2029"}))
	want := "{\"text\":\"\\u0008\\u0009\\u000a\\u000c\\u000d\\u0000\\\\\\\"<&\u2028\u2029\"}"
	if got != want {
		t.Fatalf("canonical fingerprint JSON %q, want %q", got, want)
	}
}

func TestReplaceLibraryFatalCleanupPublishesNoScript(t *testing.T) {
	c := New()
	ok := func(SegmentContext) EffectResult { return EffectResult{Status: EffectOK} }
	def, err := c.DefineSegmentCapability("r", SegmentLifecycle{Begin: ok, Commit: ok, Rollback: func(SegmentContext) EffectResult { return EffectResult{Status: EffectUnknown} }}, Operation{Name: "write", Mode: Immediate, SegmentBound: true, Result: NothingShape, Do: func(*Call, []Value) (Value, error) { return Nothing, nil }})
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	lib, err := c.CompileLibrary(LibrarySource{Name: "lib", Source: "function foo\n return 1\nend foo"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	g.AddLibrary(lib)
	a, err := g.Load(LoadOptions{Name: "a", Source: "use foo from lib\nscript variable n = 1\non go\n put 5 into n\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := g.Load(LoadOptions{Name: "b", Grants: map[string]*Grant{"r": def.GrantAll(nil)}, Source: "use foo from lib\non go\n ask r to write\n repeat 100 times\n  put 1 into z\n end repeat\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	a.Deliver(Message{Name: "go"})
	g.Pump(time.Unix(1, 0), PumpOptions{})
	b.Deliver(Message{Name: "go"})
	g.Pump(time.Unix(1, 0), PumpOptions{FuelSlice: 15})
	oldA, oldB := a.state, b.state
	newer, err := c.CompileLibrary(LibrarySource{Name: "lib", Source: "function foo\n return 2\nend foo"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = g.ReplaceLibrary(newer, ResetVariables)
	host, yes := err.(*HostError)
	if !yes || host.Code != EffectStateUnknown {
		t.Fatalf("fatal replacement: %v", err)
	}
	if a.state != oldA || b.state != oldB || g.libraries["lib"] != lib || a.state.Variables[0].Number().String() != "5" {
		t.Fatal("replacement published before all cleanup succeeded")
	}
}

func TestReissueLandsStopBeforeNextHostCall(t *testing.T) {
	for _, slice := range []int64{0, 68} {
		t.Run(fmt.Sprint(slice), func(t *testing.T) {
			c := New()
			reissue, starts := false, 0
			def, err := c.DefineCapability("api", Operation{Name: "fetch", Mode: Suspending, Result: NumberShape, Cost: Cost{Fuel: 7}, Start: func(call *Call, args []Value) error {
				if reissue {
					starts++
					call.Group().Script("s").Stop("stop reissue")
				}
				return nil
			}})
			if err != nil {
				t.Fatal(err)
			}
			grant := def.GrantAll(nil)
			g := c.NewGroup(GroupOptions{})
			s, err := g.Load(LoadOptions{Name: "s", Grants: map[string]*Grant{"api": grant}, Source: "script variable n = 0\non go\n add 1 to n\n wait for all\n  ask api to fetch and wait\n  ask api to fetch and wait\n  add 2 to n\n end wait\nend go"})
			if err != nil {
				t.Fatal(err)
			}
			s.Deliver(Message{Name: "go"})
			g.Pump(time.Unix(1, 0), PumpOptions{FuelSlice: slice})
			saved, err := g.Save()
			if err != nil {
				t.Fatal(err)
			}
			g, result, err := c.Restore(saved, RestoreOptions{Grants: func(string, string) *Grant { return grant }})
			if err != nil {
				t.Fatal(err)
			}
			reissue = true
			for _, p := range result.Pending {
				if _, err = g.Settle(p.ID, Settlement{Reissue: true}); err != nil {
					t.Fatal(err)
				}
			}
			g.Pump(time.Unix(2, 0), PumpOptions{})
			if starts != 1 {
				t.Fatalf("started %d Reissues before Stop landed", starts)
			}
		})
	}
}
func TestSettleDuringSaveBeforeFirstRestoredPump(t *testing.T) {
	c := New()
	def, err := c.DefineCapability("api", Operation{Name: "fetch", Mode: Suspending, Result: NumberShape, Start: func(*Call, []Value) error { return nil }})
	if err != nil {
		t.Fatal(err)
	}
	grant := def.GrantAll(nil)
	g := c.NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n ask api to fetch and wait\n return it\nend go", Grants: map[string]*Grant{"api": grant}})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	g.Pump(time.Unix(1, 0), PumpOptions{})
	saved, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	var restored *Group
	var id CallID
	var settlementErr error
	sink := traceFunc(func(line string) {
		if len(line) > 7 && line[:7] == "> save " {
			v := Int(42)
			_, settlementErr = restored.Settle(id, Settlement{Answer: &v})
		}
	})
	restored, result, err := c.Restore(saved, RestoreOptions{Trace: sink, Grants: func(string, string) *Grant { return grant }})
	if err != nil {
		t.Fatal(err)
	}
	id = result.Pending[0].ID
	second, err := restored.Save()
	if err != nil {
		t.Fatal(err)
	}
	if settlementErr != nil {
		t.Fatal(settlementErr)
	}
	clone, _, err := c.Restore(second, RestoreOptions{Grants: func(string, string) *Grant { return grant }})
	if err != nil {
		t.Fatal(err)
	}
	pumped, err := clone.Pump(time.Unix(2, 0), PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(operationalReports(pumped.Reports)) != 1 || operationalReports(pumped.Reports)[0].(*RunEnd).Result.String() != "42" {
		t.Fatal(operationalReports(pumped.Reports))
	}
}

func TestRestoreRejectsMalformedFunctionAndQuantity(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	_, err := g.Load(LoadOptions{Name: "s", Source: "script variable cb = given x: x\nscript variable distance = 3 m"})
	if err != nil {
		t.Fatal(err)
	}
	saved, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	for _, what := range []string{"function code", "function body", "function arity", "missing function arity", "quantity unit"} {
		t.Run(what, func(t *testing.T) {
			broken := rewriteSave(t, saved, func(data map[string]any) {
				vars := data["Scripts"].([]any)[0].(map[string]any)["Variables"].([]any)
				fn := vars[0].(map[string]any)["Function"].(map[string]any)
				switch what {
				case "function arity":
					fn["Required"] = -1
				case "missing function arity":
					delete(fn, "Total")
				case "function code":
					fn["CodeState"] = map[string]any{"$ref": "group"}
				case "function body":
					fn["Body"] = 999999
				case "quantity unit":
					vars[1].(map[string]any)["Unit"].(map[string]any)["Slots"].([]any)[0].(map[string]any)["Unit"] = -1
				}
			})
			_, _, err := c.Restore(broken, RestoreOptions{})
			host, ok := err.(*HostError)
			if !ok || host.Code != InvalidSave {
				t.Fatalf("malformed %s accepted: %v", what, err)
			}
		})
	}
}

func TestRestoreOrdersCallsByCompleteScriptName(t *testing.T) {
	c := New()
	def, err := c.DefineCapability("api", Operation{Name: "fetch", Mode: Suspending, Result: NumberShape, Start: func(*Call, []Value) error { return nil }})
	if err != nil {
		t.Fatal(err)
	}
	grant := def.GrantAll(nil)
	g := c.NewGroup(GroupOptions{})
	for _, name := range []string{"x/rz", "x/ra"} {
		s, err := g.Load(LoadOptions{Name: name, Source: "on go\n ask api to fetch and wait\nend go", Grants: map[string]*Grant{"api": grant}})
		if err != nil {
			t.Fatal(err)
		}
		s.Deliver(Message{Name: "go"})
	}
	g.Pump(time.Unix(1, 0), PumpOptions{})
	saved, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	want, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	for range 12 {
		clone, result, err := c.Restore(saved, RestoreOptions{Grants: func(string, string) *Grant { return grant }})
		if err != nil {
			t.Fatal(err)
		}
		if len(result.Pending) != 2 || result.Pending[0].Script != "x/ra" || result.Pending[1].Script != "x/rz" {
			t.Fatal(result.Pending)
		}
		got, err := clone.Save()
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, want) {
			t.Fatal("same saved state produced different snapshot bytes")
		}
	}
}

func TestReissueFuelFaultSkipsSiblingHostCalls(t *testing.T) {
	for _, slice := range []int64{0, 68} {
		t.Run(fmt.Sprint(slice), func(t *testing.T) {
			c := New()
			reissue, starts := false, 0
			def, err := c.DefineCapability("api", Operation{Name: "fetch", Mode: Suspending, Result: NumberShape, Cost: Cost{Fuel: 7}, Start: func(call *Call, args []Value) error {
				if reissue {
					starts++
					return call.Charge(10000000)
				}
				return nil
			}})
			if err != nil {
				t.Fatal(err)
			}
			grant := def.GrantAll(nil)
			g := c.NewGroup(GroupOptions{})
			s, err := g.Load(LoadOptions{Name: "s", Limits: Limits{FuelPerRun: 1000}, Grants: map[string]*Grant{"api": grant}, Source: "script variable n = 0\non go\n add 1 to n\n wait for all\n  ask api to fetch and wait\n  ask api to fetch and wait\n  add 2 to n\n end wait\nend go"})
			if err != nil {
				t.Fatal(err)
			}
			s.Deliver(Message{Name: "go"})
			g.Pump(time.Unix(1, 0), PumpOptions{FuelSlice: slice})
			saved, err := g.Save()
			if err != nil {
				t.Fatal(err)
			}
			g, result, err := c.Restore(saved, RestoreOptions{Grants: func(string, string) *Grant { return grant }})
			if err != nil {
				t.Fatal(err)
			}
			if len(result.Pending) != 2 {
				t.Fatal(result.Pending)
			}
			reissue = true
			for _, p := range result.Pending {
				if _, err = g.Settle(p.ID, Settlement{Reissue: true}); err != nil {
					t.Fatal(err)
				}
			}
			pumped, err := g.Pump(time.Unix(2, 0), PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if starts != 1 {
				t.Fatalf("started %d Host calls after reissue fault", starts)
			}
			if len(operationalReports(pumped.Reports)) != 1 || operationalReports(pumped.Reports)[0].(*RunEnd).Outcome != LimitFault {
				t.Fatal(operationalReports(pumped.Reports))
			}
		})
	}
}

func TestSaveEnvelopePreservesBytes(t *testing.T) {
	// Payload strings have already received the Codec's HTML/JavaScript escaping.
	for _, payload := range []string{`null`, `{"Text":"quotes \" and backslash \\"}`, `{"Text":"\u003c\u003e\u0026\u2028\u2029\n\u0000"}`, `[0,255,9223372036854775807]`} {
		hash := sha256.Sum256([]byte(payload))
		want := jsonData(struct {
			Hash    string `json:"hash"`
			Payload string `json:"payload"`
		}{fmt.Sprintf("%x", hash), payload})
		got := saveEnvelope([]byte(payload), hash)
		if !bytes.Equal(got, want) {
			t.Fatalf("envelope bytes differ:\n%s\n%s", got, want)
		}
		if cap(got) != len(got) {
			t.Fatalf("envelope capacity = %d, length = %d", cap(got), len(got))
		}
	}
}
