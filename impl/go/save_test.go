package northtalk

import (
	"bytes"
	"crypto/sha256"
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

func TestVariablesOnlyReportsPendingScriptCalls(t *testing.T) {
	for _, tc := range []struct {
		name, body, calls string
	}{
		{"ordinary wait", "send slow to b and wait", "[a/r1.c1]"},
		{"join members", "wait for all\n send slow to b and wait\n send slow to b and wait\nend wait", "[a/r1.c1 a/r1.c2]"},
		{"timer", "wait 1 s", "[]"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := New()
			g := c.NewGroup(GroupOptions{})
			s, err := g.Load(LoadOptions{Name: "a", Source: "script variable n = 0\non go\n add 1 to n\n" + tc.body + "\nend go"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := g.Load(LoadOptions{Name: "b", Source: "on slow\n wait 1 s\nend slow"}); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Deliver(Message{Name: "go"}); err != nil {
				t.Fatal(err)
			}
			if _, err := g.Pump(time.Unix(1, 0), PumpOptions{}); err != nil {
				t.Fatal(err)
			}
			saved, err := g.Save()
			if err != nil {
				t.Fatal(err)
			}
			restored, result, err := c.Restore(rewriteSaveVersions(t, saved, Versions{CostModel: "999"}), RestoreOptions{Mismatch: VariablesOnly})
			if err != nil {
				t.Fatal(err)
			}
			if !result.VariablesOnly || len(result.Pending) != 0 || fmt.Sprint(result.AbandonedCalls) != tc.calls {
				t.Fatalf("abandoned calls: %#v, want %s", result, tc.calls)
			}
			if got := restored.Inspect().Scripts[0].Vars[0].Val.String(); got != "1" {
				t.Fatalf("committed value lost: %s", got)
			}
		})
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
	if _, err := s.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(time.Unix(1, 0), PumpOptions{FuelSlice: 40}); err != nil {
		t.Fatal(err)
	}
	if got := g.Inspect().Scripts[0].Vars[0].Val.String(); got == "0" {
		t.Fatal("expected a provisional write before preemption")
	}
	saved, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	saved = rewriteSaveVersions(t, saved, Versions{CostModel: "999"})
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

func TestPreviousLanguageSaveRejectsOrRestoresVariablesOnly(t *testing.T) {
	c := New()
	g := c.NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "script variable n = 0\non go\n add 1 to n\n wait 10 s\nend go"})
	if err != nil {
		t.Fatal(err)
	}
	s.Deliver(Message{Name: "go"})
	g.Pump(time.Unix(0, 0), PumpOptions{})
	s.Deliver(Message{Name: "go"})
	saved, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	saved = rewriteSaveVersions(t, saved, Versions{Language: "1.0-rc.2"})
	_, _, err = c.Restore(saved, RestoreOptions{})
	if e, ok := err.(*HostError); !ok || e.Code != SaveMismatch {
		t.Fatalf("RejectMismatch: %v", err)
	}
	restored, result, err := c.Restore(saved, RestoreOptions{Mismatch: VariablesOnly})
	if err != nil {
		t.Fatal(err)
	}
	if !result.VariablesOnly || fmt.Sprint(result.DiscardedRuns) != "[s/r1]" || fmt.Sprint(result.DroppedMessages) != "[d2]" {
		t.Fatalf("variables-only result: %#v", result)
	}
	if got := restored.Inspect().Scripts[0].Vars[0].Val.String(); got != "1" {
		t.Fatalf("n = %s", got)
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
	newer, err := c.CompileLibrary(LibrarySource{Name: "lib", Source: "function foo\n return 2\nend foo"}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = g.ReplaceLibrary(newer, ResetVariables)
	host, yes := err.(*HostError)
	if !yes || host.Code != EffectStateUnknown {
		t.Fatalf("fatal replacement: %v", err)
	}
	// The rebuilt Scripts were abandoned, so a keeps its old Variables.
	found := false
	for _, script := range g.Inspect().Scripts {
		if script.Name == "a" {
			found = true
			if len(script.Vars) != 1 || script.Vars[0].Val.String() != "5" {
				t.Fatal("replacement published before all cleanup succeeded", script.Vars)
			}
		}
	}
	if !found {
		t.Fatal("replacement removed Script a")
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
