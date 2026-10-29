package northtalk_test

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	talk "github.com/odogono/odgn-talk/impl/go"
)

type bridgeCalendar struct {
	talk.CalendarImpl
	calls *[]string
}

func (h bridgeCalendar) Today(c *talk.Call, zone string) (talk.Value, error) {
	*h.calls = append(*h.calls, "today:"+zone)
	data, _ := talk.Map(talk.KV("zone", bridgeText("Mars")))
	return talk.Nothing, &talk.ScriptError{Code: "unknown zone", Data: data}
}

type bridgeLocale struct {
	talk.LocaleImpl
	calls *[]string
}

func (h bridgeLocale) Compare(c *talk.Call, a, b, options talk.Value, tag string) (talk.Value, error) {
	*h.calls = append(*h.calls, "compare:"+tag+":"+options.String())
	return talk.Int(4), nil // Shape-valid but outside the factory's result domain.
}

type bridgeUser struct {
	talk.UserImpl
	calls   *[]string
	pending **talk.Call
}

func (h bridgeUser) Choose(c *talk.Call, items []string, prompt string, multiple bool) error {
	*h.calls = append(*h.calls, fmt.Sprintf("choose:%v:%s:%t", items, prompt, multiple))
	*h.pending = c
	return nil
}

type bridgeStore struct {
	talk.StoreImpl
	calls *[]string
}

func (h *bridgeStore) Release(c talk.GrantContext) {
	*h.calls = append(*h.calls, "release:"+c.GrantName+":"+string(c.Reason))
}
func (h *bridgeStore) Begin(c talk.SegmentContext) talk.EffectResult {
	*h.calls = append(*h.calls, "begin:"+c.GrantName)
	return talk.EffectResult{Status: talk.EffectOK}
}
func (h *bridgeStore) Commit(c talk.SegmentContext) talk.EffectResult {
	names := []string{}
	for _, g := range c.Grants {
		names = append(names, fmt.Sprintf("%s=%v", g.GrantName, g.Binding))
	}
	*h.calls = append(*h.calls, "commit:"+strings.Join(names, ","))
	return talk.EffectResult{Status: talk.EffectOK}
}
func (h *bridgeStore) Rollback(c talk.SegmentContext) talk.EffectResult {
	*h.calls = append(*h.calls, "rollback:"+c.GrantName)
	return talk.EffectResult{Status: talk.EffectOK}
}
func (h *bridgeStore) Set(c *talk.Call, key string, value talk.Value) error {
	*h.calls = append(*h.calls, "set:"+c.GrantName()+":"+key+":"+value.String())
	return nil
}
func (h *bridgeStore) Watch(c *talk.Call, name, prefix, message string) error {
	*h.calls = append(*h.calls, "watch:"+name+":"+prefix+":"+message)
	return nil
}

type bridgeSqlite struct {
	talk.SqliteImpl
	calls     *[]string
	lifecycle *talk.SegmentLifecycle
}

func (h *bridgeSqlite) Coordinator(database string) *talk.SegmentLifecycle {
	*h.calls = append(*h.calls, "coordinator:"+database)
	return h.lifecycle
}
func (h *bridgeSqlite) Query(c *talk.Call, sql string, params talk.SqlParams, max int64, beforeStep func() error) (talk.SqlRows, error) {
	*h.calls = append(*h.calls, fmt.Sprintf("query:%s:%v:%d", sql, params.List, max))
	// One row, then the completion check.
	for range 2 {
		if err := beforeStep(); err != nil {
			return talk.SqlRows{}, err
		}
	}
	return talk.SqlRows{Columns: []string{"n"}, Rows: [][]talk.SqlValue{{int64(7)}}}, nil
}
func (h *bridgeSqlite) Begin(c *talk.Call) error {
	*h.calls = append(*h.calls, "begin:"+c.ScopeName())
	return nil
}
func (h *bridgeSqlite) Rollback(c *talk.Call) error {
	*h.calls = append(*h.calls, fmt.Sprintf("rollback:%s:%t", c.ScopeName(), c.Automatic()))
	return nil
}

func bridgeText(s string) talk.Value {
	v, err := talk.Text(s)
	if err != nil {
		panic(err)
	}
	return v
}

func runStandardBridgeCases(t *testing.T) []bridgeObservation {
	var observations []bridgeObservation
	for _, name := range []string{"calendar failure", "calendar domain", "locale result", "locale domain", "locale NUL binding", "user result", "user domain", "store shared", "store domain", "store watch", "sqlite rows", "sqlite domain", "sqlite scope"} {
		t.Run(name, func(t *testing.T) {
			o := bridgeObservation{Name: name}
			var trace bridgeTrace
			core := talk.New()
			g := core.NewGroup(talk.GroupOptions{Trace: &trace})
			costs := func(names ...string) talk.Costs {
				c := talk.Costs{}
				for _, n := range names {
					c[n] = talk.Cost{Fuel: 3, Alloc: 2}
				}
				return c
			}
			var def *talk.CapabilityDef
			var err error
			var pendingCall *talk.Call
			var binding any
			body := ""
			switch strings.Fields(name)[0] {
			case "calendar":
				def, err = core.CalendarCapability(bridgeCalendar{calls: &o.Calls}, costs("now", "offset", "toCivil", "toInstant", "today", "zone"))
				body = "ask api to today"
				if name == "calendar domain" {
					body = "ask api to toInstant 2026-10-16"
				}
			case "locale":
				def, err = core.LocaleCapability(bridgeLocale{calls: &o.Calls}, costs("compare", "dayNames", "lower", "monthNames", "numberSymbols", "rank", "tag", "upper"))
				binding = "en-GB"
				body = "ask api to compare \"a\", \"b\""
				if name == "locale NUL binding" {
					binding = "en\x00bad"
				}
				if name == "locale domain" {
					binding = "bad_tag"
				}
			case "user":
				def, err = core.UserCapability(bridgeUser{calls: &o.Calls, pending: &pendingCall}, costs("choose", "confirm", "enter", "notify"))
				body = "ask api to choose [\"a\", \"b\"], {prompt: nothing} and wait"
				if name == "user domain" {
					body = "ask api to choose [] and wait"
				}
			case "store":
				def, err = core.StoreCapability(&bridgeStore{calls: &o.Calls}, costs("delete", "get", "increment", "keys", "set", "swap", "unwatch", "watch"))
				binding = "first"
				body = "ask api to set \"k\", 1\nask alias to set \"q\", 2"
				if name == "store domain" {
					body = "ask api to set \"\", 1"
				}
				if name == "store watch" {
					body = "ask api to watch \"w\", \"\", nothing"
				}
			case "sqlite":
				hook := func(c talk.SegmentContext) talk.EffectResult {
					o.Calls = append(o.Calls, "effect:"+c.SegmentID+":"+c.GrantName)
					return talk.EffectResult{Status: talk.EffectOK}
				}
				def, err = core.SqliteCapability(&bridgeSqlite{calls: &o.Calls, lifecycle: &talk.SegmentLifecycle{Begin: hook, Commit: hook, Rollback: hook}}, costs("begin", "change", "commit", "query", "rollback"), 5)
				binding = talk.SqliteBinding{Database: "db", MaxRows: 3}
				body = "ask api to query \"select ?\", [true]"
				if name == "sqlite domain" {
					body = "ask api to query \"select ?\", [true], 4"
				}
				if name == "sqlite scope" {
					body = "ask api to begin"
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			grants := map[string]*talk.Grant{"api": def.GrantAll(binding)}
			if strings.HasPrefix(name, "store") {
				grants["alias"] = def.GrantAll("second")
			}
			s, err := g.Load(talk.LoadOptions{Name: "s", Source: "on go\n" + body + "\nreturn it\nend go", Grants: grants, GrantsAsUsed: true})
			if err != nil {
				t.Fatal(err)
			}
			_, p, err := s.Request(nil, talk.Message{Name: "go"})
			if err != nil {
				t.Fatal(err)
			}
			pump := func() {
				r, err := g.Pump(bridgeNow, talk.PumpOptions{})
				if err != nil {
					t.Fatal(err)
				}
				o.Pumps = append(o.Pumps, bridgeCanonical(reflect.ValueOf(r)), bridgeCanonical(reflect.ValueOf(g.Inspect())))
			}
			pump()
			if pendingCall != nil {
				pendingCall.Answer(bridgeText("absent"))
				pump()
			}
			select {
			case <-p.Done():
			default:
				t.Fatal("unsettled Standard call")
			}
			v, failure := p.Result()
			o.Values = append(o.Values, v.String(), fmt.Sprint(bridgeCanonical(reflect.ValueOf(failure))))
			o.Trace = append([]string{}, trace.lines...)
			observations = append(observations, o)
		})
	}
	return observations
}
