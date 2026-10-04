package check

import (
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
)

func TestJoinRejectsPlainCallToSuspendingLocalHandler(t *testing.T) {
	for _, tc := range []struct {
		name, source string
		positions    []syntax.Position
	}{
		{"helper Join cannot overwrite open Join", `on go
 wait for all
  send ping to me and wait
  helper
 end wait
end go
on helper
 wait for all
  send ping to me and wait
 end wait
end helper
on ping
 return 7
end ping`, []syntax.Position{{Line: 4, Column: 3}}},
		{"direct wait", "on go\n helper\nend go\non helper\n wait 1 s\nend helper", []syntax.Position{{Line: 2, Column: 2}}},
		{"transitive suspension", `on go
 wait for all
  send ping to me and wait
  helper
 end wait
end go
on helper
 bridge
end helper
on bridge
 wait 1 s
end bridge
on ping
 return 7
end ping`, []syntax.Position{{Line: 4, Column: 3}, {Line: 8, Column: 2}}},
		{"any suspending Handler clause", `on go
 helper 1
end go
on helper 0
 return 0
end helper
on helper n
 wait 1 s
end helper`, []syntax.Position{{Line: 2, Column: 2}}},
		{"call within block Lambda", `on go
 put given
  helper
 end into f
end go
on helper
 wait 1 s
end helper`, []syntax.Position{{Line: 3, Column: 3}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tree, err := syntax.Parse(tc.source)
			if err != nil {
				t.Fatal(err)
			}
			u := Check(tree, Options{})
			for _, pos := range tc.positions {
				found := false
				for _, d := range u.Diagnostics {
					if d.Code == "missing and wait" && d.Pos == pos {
						found = true
					}
				}
				if !found {
					t.Errorf("expected missing and wait at %d:%d, diagnostics: %v", pos.Line, pos.Column, u.Diagnostics)
				}
			}
			for _, d := range u.Diagnostics {
				if d.Code != "missing and wait" {
					t.Errorf("unexpected diagnostic: %+v", d)
				}
			}
		})
	}
}

func TestJoinAllowsPureLocalHandlerCalls(t *testing.T) {
	for _, tc := range []struct{ name, source string }{
		{"pure helper in Join", `on go
 wait for all
  send ping to me and wait
  helper
 end wait
end go
on helper
 return 7
end helper
on ping
 return 9
end ping`},
		{"transitively pure helper in Join", `on go
 wait for all
  send ping to me and wait
  helper
 end wait
end go
on helper
 bridge
end helper
on bridge
 return 7
end bridge
on ping
 return 9
end ping`},
		{"pure function-style helper in Join", `on go
 wait for all
  send ping to me and wait
  put helper() into result
 end wait
end go
on helper
 return 7
end helper
on ping
 return 9
end ping`},
		{"waited suspending call outside Join", "on go\n helper and wait\nend go\non helper\n wait 1 s\nend helper"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tree, err := syntax.Parse(tc.source)
			if err != nil {
				t.Fatal(err)
			}
			if u := Check(tree, Options{}); len(u.Diagnostics) != 0 {
				t.Fatal(u.Diagnostics)
			}
		})
	}
}

func TestJoinRejectsFunctionStyleCallToSuspendingHandler(t *testing.T) {
	for _, tc := range []struct {
		name, source string
		pos          syntax.Position
	}{
		{"direct expression in Join", `on go
 wait for all
  send ping to me and wait
  put helper() into result
 end wait
end go
on helper
 wait for all
  send ping to me and wait
 end wait
end helper
on ping
 return 7
end ping`, syntax.Position{Line: 4, Column: 7}},
		{"pure function wrapper", `function wrapper
 return helper()
end wrapper
on helper
 wait for all
  send ping to me and wait
 end wait
end helper
on go
 wait for all
  send ping to me and wait
  put wrapper() into result
 end wait
end go
on ping
 return 7
end ping`, syntax.Position{Line: 2, Column: 9}},
		{"block Lambda expression", `on go
 put given
  return helper()
 end into f
end go
on helper
 wait for all
  send ping to me and wait
 end wait
end helper
on ping
 return 7
end ping`, syntax.Position{Line: 3, Column: 10}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tree, err := syntax.Parse(tc.source)
			if err != nil {
				t.Fatal(err)
			}
			u := Check(tree, Options{})
			for _, d := range u.Diagnostics {
				if d.Code == "can't suspend here" && d.Pos == tc.pos {
					return
				}
			}
			t.Fatalf("expected can't suspend here at %d:%d; diagnostics: %v", tc.pos.Line, tc.pos.Column, u.Diagnostics)
		})
	}
}
