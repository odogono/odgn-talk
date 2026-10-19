package northtalk

import "testing"

// A Result Target holds a suspending ask's result once it resumes, and keeps
// its old value when the ask raises (ADR 0112).
func TestResultTargetAfterSuspendingAsk(t *testing.T) {
	for _, tc := range []struct {
		name, want string
		fail       bool
	}{
		{"resumes", "[7, 7, 7]", false},
		{"raises", "[5, 0]", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := New()
			var call *Call
			def, err := c.DefineCapability("api", Operation{Name: "read", Mode: Suspending, Result: NumberShape, Start: func(c *Call, _ []Value) error { call = c; return nil }})
			if err != nil {
				t.Fatal(err)
			}
			g := c.NewGroup(GroupOptions{})
			source := "script variable last = 0\non go\n put 5 into saved\n try\n  ask api to read into saved and wait\n  ask api to read into last and wait\n  return [saved, last, it]\n catch e\n  return [saved, last]\n end try\nend go\n"
			s, err := g.Load(LoadOptions{Name: "s", Source: source, Grants: map[string]*Grant{"api": def.GrantAll(nil)}})
			if err != nil {
				t.Fatal(err)
			}
			s.Deliver(Message{Name: "go"})
			joinPump(t, g, 0, PumpOptions{})
			var end *RunEnd
			for second := int64(1); second <= 2 && end == nil; second++ {
				if call == nil {
					t.Fatal("ask did not suspend")
				}
				if tc.fail {
					call.Fail(&ScriptError{Code: "read failed"})
				} else {
					call.Answer(Int(7))
				}
				call = nil
				r := joinPump(t, g, second, PumpOptions{})
				for _, report := range operationalReports(r.Reports) {
					if e, ok := report.(*RunEnd); ok && e.Script == "s" {
						end = e
					}
				}
			}
			if end == nil || end.Outcome != Completed || end.Result.String() != tc.want {
				t.Fatal(end)
			}
		})
	}
}
