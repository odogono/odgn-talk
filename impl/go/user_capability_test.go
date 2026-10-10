package northtalk

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"
)

type userHost struct {
	calls []*Call
	shown [][]any
	busy  map[string]bool
}

func (h *userHost) Confirm(c *Call, message string) error {
	if h.busy != nil {
		if h.busy[c.ScriptName()] {
			return &ScriptError{Code: "user busy"}
		}
		h.busy[c.ScriptName()] = true
	}
	h.calls = append(h.calls, c)
	h.shown = append(h.shown, []any{"confirm", message})
	return nil
}
func (h *userHost) Choose(c *Call, items []string, prompt string, multiple bool) error {
	h.calls = append(h.calls, c)
	h.shown = append(h.shown, []any{"choose", items, prompt, multiple})
	return nil
}
func (h *userHost) Enter(c *Call, message, fallback string) error {
	h.calls = append(h.calls, c)
	h.shown = append(h.shown, []any{"enter", message, fallback})
	return nil
}
func (h *userHost) Notify(_ *Call, message, title string) error {
	h.shown = append(h.shown, []any{"notify", message, title})
	return nil
}

var userCosts = Costs{"confirm": {Fuel: 3}, "choose": {Fuel: 5}, "enter": {Fuel: 7}, "notify": {Fuel: 2}}
var userNow = time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)

// userRun requests a Handler that returns `it` after body, or the code of the
// error it caught, and pumps once.
func userRun(t *testing.T, host *userHost, body string) (*Group, *Pending) {
	t.Helper()
	core := New()
	def, err := core.UserCapability(host, userCosts)
	if err != nil {
		t.Fatal(err)
	}
	g := core.NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n try\n  " + body + "\n  return it\n catch {code: code}\n  return code\n end\nend go\n", Grants: map[string]*Grant{"user": def.GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	_, p, err := s.Request(context.Background(), Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(userNow, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	return g, p
}
func userResult(t *testing.T, g *Group, p *Pending) string {
	t.Helper()
	if _, err := g.Pump(userNow.Add(time.Millisecond), PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	value, failure := p.Result()
	if failure != nil {
		t.Fatalf("failed: %v", failure)
	}
	if text, ok := value.AsText(); ok {
		return text
	}
	return value.String()
}

func TestUserFactoryRefusesMissingCostsAndImplementation(t *testing.T) {
	core := New()
	for name := range userCosts {
		costs := Costs{}
		for k, v := range userCosts {
			if k != name {
				costs[k] = v
			}
		}
		def, err := core.UserCapability(&userHost{}, costs)
		var host *HostError
		if def != nil || !errors.As(err, &host) || host.Code != InvalidValue {
			t.Fatalf("without %s: %v, %v", name, def, err)
		}
	}
	for _, impl := range []UserImpl{nil, (*userHost)(nil)} {
		if def, err := core.UserCapability(impl, userCosts); def != nil || err == nil {
			t.Fatalf("nil impl: %v, %v", def, err)
		}
	}
}

func TestUserPassesArgumentsAndOptionsToTheHost(t *testing.T) {
	host := &userHost{}
	for _, body := range []string{
		`ask user to confirm "Delete?" and wait`,
		`ask user to choose ["S", "M"] and wait`,
		`ask user to choose ["S", "M"], {prompt: "Size", multiple: true} and wait`,
		`ask user to choose ["S"], {prompt: nothing} and wait`,
		`ask user to enter "Name?" and wait`,
		`ask user to enter "Name?", {default: "Ann"} and wait`,
		`tell user to notify "Done", {title: "Backup"}`,
		`tell user to notify "Done"`,
	} {
		userRun(t, host, body)
	}
	want := [][]any{
		{"confirm", "Delete?"},
		{"choose", []string{"S", "M"}, "", false},
		{"choose", []string{"S", "M"}, "Size", true},
		{"choose", []string{"S"}, "", false},
		{"enter", "Name?", ""},
		{"enter", "Name?", "Ann"},
		{"notify", "Done", "Backup"},
		{"notify", "Done", ""},
	}
	if !reflect.DeepEqual(host.shown, want) {
		t.Fatalf("%v", host.shown)
	}
}

func TestUserAnswersAndCancels(t *testing.T) {
	for _, c := range []struct {
		body   string
		answer Value
		want   string
	}{
		{`ask user to confirm "x" and wait`, Bool(true), "true"},
		{`ask user to confirm "x" and wait`, Bool(false), "false"},
		{`ask user to choose ["S", "M"] and wait`, mustPublicText("M"), "M"},
		{`ask user to choose ["S", "M"] and wait`, Nothing, "nothing"},
		{`ask user to choose ["S", "M", "L"], {multiple: true} and wait`, List(mustPublicText("S"), mustPublicText("L")), `["S", "L"]`},
		{`ask user to choose ["S", "S"], {multiple: true} and wait`, List(mustPublicText("S"), mustPublicText("S")), `["S", "S"]`},
		{`ask user to enter "x" and wait`, Nothing, "nothing"},
		// Answers the Core refuses.
		{`ask user to choose ["S", "M"] and wait`, mustPublicText("X"), "host error"},
		{`ask user to choose ["S", "M"] and wait`, List(mustPublicText("S")), "host error"},
		{`ask user to choose ["S", "M"], {multiple: true} and wait`, mustPublicText("S"), "host error"},
		{`ask user to choose ["S", "M"], {multiple: true} and wait`, List(mustPublicText("M"), mustPublicText("S")), "host error"},
		{`ask user to choose ["S", "M"], {multiple: true} and wait`, List(mustPublicText("S"), mustPublicText("S")), "host error"},
		{`ask user to confirm "x" and wait`, mustPublicText("yes"), "host error"},
	} {
		host := &userHost{}
		g, p := userRun(t, host, c.body)
		host.calls[0].Answer(c.answer)
		if got := userResult(t, g, p); got != c.want {
			t.Fatalf("%s answered %v: %s", c.body, c.answer, got)
		}
	}
}

func TestUserRefusesAnEmptyChooseAndUnknownOptionsBeforeTheHost(t *testing.T) {
	for body, want := range map[string]string{
		`ask user to choose [] and wait`:                                           "out of domain",
		"put {colour: \"red\"} into o\n  ask user to enter \"x\", o and wait":      "wrong kind",
		"put {multiple: \"yes\"} into o\n  ask user to choose [\"S\"], o and wait": "wrong kind",
		"put [1] into xs\n  ask user to choose xs and wait":                        "wrong kind",
	} {
		host := &userHost{}
		g, p := userRun(t, host, body)
		if got := userResult(t, g, p); got != want || len(host.calls) != 0 {
			t.Fatalf("%s: %s, %d calls", body, got, len(host.calls))
		}
	}
}

func TestUserBusyFromTheHostReachesTheScript(t *testing.T) {
	host := &userHost{busy: map[string]bool{}}
	core := New()
	def, err := core.UserCapability(host, userCosts)
	if err != nil {
		t.Fatal(err)
	}
	g := core.NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: "on go\n try\n  ask user to confirm \"x\" and wait\n catch {code: code}\n  return code\n end\nend go\n", Grants: map[string]*Grant{"user": def.GrantAll(nil)}})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Request(context.Background(), Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	_, second, err := s.Request(context.Background(), Message{Name: "go"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(userNow, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if got := userResult(t, g, second); got != "user busy" {
		t.Fatal(got)
	}
}
