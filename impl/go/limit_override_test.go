package northtalk

import (
	"testing"
	"time"
)

func TestQueuedZeroOverridesSurviveSaveRestore(t *testing.T) {
	for _, tc := range []struct {
		name, body, limit string
		override          LimitOverride
		outcome           Outcome
	}{
		{"omitted", "return 42", "", LimitOverride{}, Completed},
		{"fuel", "return 42", "fuel", LimitOverride{Set: OverrideFuelPerRun}, LimitFault},
		{"allocation", "return [42]", "alloc", LimitOverride{Set: OverrideAllocPerRun}, LimitFault},
		{"wait", "ask api to read and wait", "", LimitOverride{Set: OverrideMaxWait}, Errored},
		{"join", "wait for all\n ask api to read and wait\nend wait", "join", LimitOverride{Set: OverrideMaxJoin}, LimitFault},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := New()
			cap, err := c.DefineCapability("api", Operation{Name: "read", Mode: Suspending, Result: AnyShape, Start: func(*Call, []Value) error { return nil }})
			if err != nil {
				t.Fatal(err)
			}
			g := c.NewGroup(GroupOptions{})
			s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n" + tc.body + "\nend go\n", Grants: map[string]*Grant{"api": cap.GrantAll(nil)}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.Deliver(Message{Name: "go", Limits: &tc.override}); err != nil {
				t.Fatal(err)
			}
			saved, err := g.Save()
			if err != nil {
				t.Fatal(err)
			}
			g, _, err = c.Restore(saved, RestoreOptions{Grants: func(string, string) *Grant { return cap.GrantAll(nil) }})
			if err != nil {
				t.Fatal(err)
			}
			result, err := g.Pump(time.Unix(1, 0), PumpOptions{})
			if err != nil {
				t.Fatal(err)
			}
			if tc.name == "wait" {
				if !result.NextDeadline.Equal(time.Unix(1, 0)) {
					t.Fatalf("zero MaxWait deadline=%v", result.NextDeadline)
				}
				result, err = g.Pump(time.Unix(1, 0), PumpOptions{})
				if err != nil {
					t.Fatal(err)
				}
			}
			if len(result.Reports) != 1 {
				t.Fatal(result)
			}
			end, ok := result.Reports[0].(*RunEnd)
			if !ok || end.Outcome != tc.outcome || end.Limit != tc.limit {
				t.Fatal(result.Reports)
			}
			if tc.name == "wait" && end.Error.Code != "timeout" {
				t.Fatal(end.Error)
			}
		})
	}
}

func TestOverrideRejectsUnknownPresenceBits(t *testing.T) {
	g := New().NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\nreturn 1\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Deliver(Message{Name: "go", Limits: &LimitOverride{Set: 1 << 7}}); err == nil {
		t.Fatal("unknown field mask accepted")
	}
}
