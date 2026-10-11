package northtalk

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

var releaseNow = time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)

const releaseSource = "on go\n ask api to touch\nend go\n"

func releaseCapability(t *testing.T, c *Core, hook ReleaseHook) *CapabilityDef {
	t.Helper()
	options := []CapabilityOption{Operation{Name: "touch", Mode: Immediate, Result: NothingShape, Do: func(*Call, []Value) (Value, error) { return Nothing, nil }}}
	if hook != nil {
		options = append(options, WithReleaseHook(hook))
	}
	d, err := c.DefineCapability("resource", options...)
	if err != nil {
		t.Fatal(err)
	}
	return d
}
func releaseLoad(t *testing.T, g *Group, name, source string, grants map[string]*Grant) *Script {
	t.Helper()
	s, err := g.Load(LoadOptions{Name: name, Source: source, Grants: grants})
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func releasePump(t *testing.T, g *Group) PumpResult {
	t.Helper()
	r, err := g.Pump(releaseNow, PumpOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func releaseEvents(t *testing.T, got, want []string) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("events %v; want %v", got, want)
	}
}

type releaseTrace struct{ events *[]string }

func (r releaseTrace) Record(line string) {
	if strings.HasPrefix(line, "stopped ") {
		*r.events = append(*r.events, "stopped:"+strings.Fields(line)[1])
	}
	if strings.HasPrefix(line, "effect-failure ") {
		*r.events = append(*r.events, "effect failure")
	}
}

func TestGrantReleaseStopAndRevocation(t *testing.T) {
	c := New()
	var events []string
	var contexts []GrantContext
	d := releaseCapability(t, c, func(ctx GrantContext) {
		contexts = append(contexts, ctx)
		events = append(events, string(ctx.Reason)+":"+ctx.GrantName)
	})
	g := c.NewGroup(GroupOptions{Name: "g", Trace: releaseTrace{&events}})
	s := releaseLoad(t, g, "s", releaseSource, map[string]*Grant{"api": d.GrantAll("binding"), "\uE000": d.GrantAll("bmp"), "𐀀": d.GrantAll("supplementary")})
	s.Revoke("api")
	if len(events) != 0 {
		t.Fatal(events)
	}
	releasePump(t, g)
	s.Revoke("api")
	s.Revoke("missing")
	releasePump(t, g)
	releaseEvents(t, events, []string{"revoke:api"})
	s.Stop("done")
	releasePump(t, g)
	releaseEvents(t, events, []string{"revoke:api", "stop:api", "stop:\uE000", "stop:𐀀", "stopped:s"})
	ctx := contexts[1]
	if ctx.Group != g || ctx.ScriptName != "s" || ctx.Binding != "binding" || ctx.Now != releaseNow {
		t.Fatal(ctx)
	}
	s.Stop("again")
	releasePump(t, g)
	if len(contexts) != 4 {
		t.Fatal(contexts)
	}
}

func TestGrantReleaseOwnerDisposal(t *testing.T) {
	c := New()
	var contexts []GrantContext
	d := releaseCapability(t, c, func(ctx GrantContext) { contexts = append(contexts, ctx) })
	kind, err := c.DefineObjectKind(ObjectKindDef{Name: "owner"})
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{})
	owner, err := g.Object(kind, "owner", nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = g.Load(LoadOptions{Name: "s", Source: releaseSource, Owner: owner, Grants: map[string]*Grant{"api": d.GrantAll("binding")}})
	if err != nil {
		t.Fatal(err)
	}
	if err = g.Dispose(owner); err != nil {
		t.Fatal(err)
	}
	releasePump(t, g)
	if len(contexts) != 1 || contexts[0].Reason != ReleaseStop || contexts[0].ScriptName != "s" {
		t.Fatal(contexts)
	}
}

func TestGrantReleaseAfterAbandonmentAndRollback(t *testing.T) {
	c := New()
	var events []string
	lifecycle := SegmentLifecycle{Begin: effectOK, Commit: effectOK, Rollback: func(ctx SegmentContext) EffectResult { events = append(events, "rollback"); return effectOK(ctx) }}
	d, err := c.DefineSegmentCapability("resource", lifecycle,
		Operation{Name: "open", Mode: Immediate, Result: NothingShape, SegmentBound: true, Scope: &ScopeDecl{Opens: "file", Abandon: "close"}, Do: func(call *Call, _ []Value) (Value, error) {
			call.Group().Script(call.ScriptName()).Stop("done")
			return Nothing, nil
		}},
		Operation{Name: "close", Mode: Immediate, Result: NothingShape, SegmentBound: true, Scope: &ScopeDecl{Closes: "file"}, Do: func(*Call, []Value) (Value, error) { events = append(events, "abandon"); return Nothing, nil }},
		WithReleaseHook(func(GrantContext) { events = append(events, "release") }))
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{Trace: releaseTrace{&events}})
	s := releaseLoad(t, g, "s", "on go\nask api to open\nend go", map[string]*Grant{"api": d.GrantAll("binding")})
	if _, err = s.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	releasePump(t, g)
	releaseEvents(t, events, []string{"abandon", "rollback", "release", "stopped:s"})
}

func TestGrantReleaseDisableBeforeNextAbandonment(t *testing.T) {
	c := New()
	var events []string
	d, err := c.DefineCapability("resource",
		Operation{Name: "open", Mode: Immediate, Result: NothingShape, Scope: &ScopeDecl{Opens: "file", Abandon: "close"}, Do: func(*Call, []Value) (Value, error) { return Nothing, nil }},
		Operation{Name: "close", Mode: Immediate, Result: NothingShape, Scope: &ScopeDecl{Closes: "file"}, Do: func(call *Call, _ []Value) (Value, error) {
			events = append(events, "abandon:"+call.GrantName())
			return Nothing, errors.New("failure")
		}},
		WithReleaseHook(func(ctx GrantContext) { events = append(events, string(ctx.Reason)+":"+ctx.GrantName) }))
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{Trace: releaseTrace{&events}})
	s := releaseLoad(t, g, "s", "on go\nask a to open\nask z to open\nend go", map[string]*Grant{"a": d.GrantAll("a"), "z": d.GrantAll("z")})
	s.Deliver(Message{Name: "go"})
	releasePump(t, g)
	releaseEvents(t, events, []string{"abandon:z", "effect failure", "disable:z", "abandon:a", "effect failure", "disable:a"})
	s.Stop("done")
	releasePump(t, g)
	releaseEvents(t, events[len(events)-3:], []string{"stop:a", "stop:z", "stopped:s"})
}

func TestGrantReleaseFatalUncertainty(t *testing.T) {
	c := New()
	var events []string
	d, err := c.DefineSegmentCapability("resource", SegmentLifecycle{Begin: effectOK, Commit: func(SegmentContext) EffectResult { return EffectResult{Status: EffectUnknown} }, Rollback: func(ctx SegmentContext) EffectResult { events = append(events, "rollback"); return effectOK(ctx) }},
		Operation{Name: "touch", Mode: Immediate, Result: NothingShape, SegmentBound: true, Do: func(*Call, []Value) (Value, error) { return Nothing, nil }},
		WithReleaseHook(func(ctx GrantContext) { events = append(events, string(ctx.Reason)+":"+ctx.ScriptName) }))
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{Trace: releaseTrace{&events}})
	releaseLoad(t, g, "first", releaseSource, map[string]*Grant{"api": d.GrantAll("first")})
	s := releaseLoad(t, g, "second", releaseSource, map[string]*Grant{"api": d.GrantAll("second")})
	s.Deliver(Message{Name: "go"})
	releasePump(t, g)
	releaseEvents(t, events, []string{"effect failure", "rollback", "stop:first", "stopped:first", "stop:second", "stopped:second"})
}

func TestGrantReleaseReloadAndNoReleaseCases(t *testing.T) {
	c := New()
	var contexts []GrantContext
	var reentries []error
	d := releaseCapability(t, c, func(ctx GrantContext) {
		contexts = append(contexts, ctx)
		_, err := ctx.Group.Save()
		reentries = append(reentries, err)
	})
	grant := d.GrantAll("binding")
	g := c.NewGroup(GroupOptions{})
	s := releaseLoad(t, g, "s", releaseSource, map[string]*Grant{"api": grant})
	releasePump(t, g)
	if _, err := s.Reload("on", ResetVariables); err == nil {
		t.Fatal("bad Reload accepted")
	}
	if err := s.Extend("script variable extra = 1"); err != nil {
		t.Fatal(err)
	}
	save, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	copy, _, err := c.Restore(save, RestoreOptions{Grants: func(string, string) *Grant { return grant }})
	if err != nil {
		t.Fatal(err)
	}
	if len(contexts) != 0 {
		t.Fatal(contexts)
	}
	if _, err := s.Reload(releaseSource, ResetVariables); err != nil {
		t.Fatal(err)
	}
	if len(contexts) != 1 || contexts[0].Reason != ReleaseReload || contexts[0].Now != releaseNow {
		t.Fatal(contexts)
	}
	var host *HostError
	if !errors.As(reentries[0], &host) || host.Code != ReentrantCall {
		t.Fatal(reentries)
	}
	copy.Script("s").Stop("copy")
	releasePump(t, copy)
	if contexts[1].Group != copy {
		t.Fatal(contexts)
	}
	s.Stop("stop")
	releasePump(t, g)
	if _, err := s.Reload(releaseSource, ResetVariables); err != nil {
		t.Fatal(err)
	}
	if contexts[3].Reason != ReleaseReload {
		t.Fatal(contexts)
	}
}

func TestGrantReleaseLibraryReplacement(t *testing.T) {
	c := New()
	var events []string
	d := releaseCapability(t, c, func(ctx GrantContext) { events = append(events, ctx.ScriptName+":"+string(ctx.Reason)) })
	compile := func(source string) *Library {
		t.Helper()
		l, err := c.CompileLibrary(LibrarySource{Name: "helper", Source: source}, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		return l
	}
	g := c.NewGroup(GroupOptions{})
	if err := g.AddLibrary(compile("function f\nreturn 1\nend f")); err != nil {
		t.Fatal(err)
	}
	releaseLoad(t, g, "s", "use f from helper\non go\nreturn f()\nend go", map[string]*Grant{"api": d.GrantAll("s")})
	releaseLoad(t, g, "other", releaseSource, map[string]*Grant{"api": d.GrantAll("other")})
	if _, err := g.ReplaceLibrary(compile("function g\nreturn 2\nend g"), ResetVariables); err == nil {
		t.Fatal("bad replacement accepted")
	}
	if len(events) != 0 {
		t.Fatal(events)
	}
	if _, err := g.ReplaceLibrary(compile("function f\nreturn 2\nend f"), ResetVariables); err != nil {
		t.Fatal(err)
	}
	releaseEvents(t, events, []string{"s:reload"})
}

type releaseReplacementTrace struct {
	releaseTrace
	trace *lines
}

func (r releaseReplacementTrace) Record(line string) {
	r.releaseTrace.Record(line)
	r.trace.Record(line)
}

func TestGrantReleaseLibraryReplacementCleanup(t *testing.T) {
	for _, status := range []EffectStatus{EffectOK, EffectFailed, EffectUnknown} {
		t.Run(string(status), func(t *testing.T) {
			c := New()
			var events []string
			var trace lines
			d, err := c.DefineSegmentCapability("resource", SegmentLifecycle{
				Begin: func(ctx SegmentContext) EffectResult {
					events = append(events, "begin:"+ctx.ScriptName)
					return effectOK(ctx)
				},
				Commit: effectOK,
				Rollback: func(ctx SegmentContext) EffectResult {
					events = append(events, "rollback:"+ctx.ScriptName)
					if ctx.ScriptName == "second" {
						return EffectResult{Status: status}
					}
					return effectOK(ctx)
				},
			}, Operation{Name: "touch", Mode: Immediate, Result: NothingShape, SegmentBound: true, Do: func(*Call, []Value) (Value, error) { return Nothing, nil }},
				WithReleaseHook(func(ctx GrantContext) { events = append(events, string(ctx.Reason)+":"+ctx.ScriptName) }))
			if err != nil {
				t.Fatal(err)
			}
			compile := func(value string) *Library {
				t.Helper()
				lib, err := c.CompileLibrary(LibrarySource{Name: "helper", Version: value, Source: "function f\nreturn " + value + "\nend f"}, nil, nil)
				if err != nil {
					t.Fatal(err)
				}
				return lib
			}
			g := c.NewGroup(GroupOptions{Name: "g", Trace: releaseReplacementTrace{releaseTrace{&events}, &trace}})
			if err := g.AddLibrary(compile("1")); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"first", "second"} {
				s := releaseLoad(t, g, name, "use f from helper\non go\nask api to touch\nrepeat forever\nend repeat\nend go", map[string]*Grant{"api": d.GrantAll(name)})
				if _, err := s.Deliver(Message{Name: "go"}); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := g.Pump(releaseNow, PumpOptions{FuelSlice: 40}); err != nil {
				t.Fatal(err)
			}
			releaseEvents(t, events, []string{"begin:first", "begin:second"})
			events = nil
			trace = nil
			before := g.Fingerprint()
			_, err = g.ReplaceLibrary(compile("2"), ResetVariables)
			fatal := status != EffectOK
			reason, stopReason := "reload", "reload"
			if fatal {
				reason, stopReason = "stop", "effect state unknown"
				var host *HostError
				if !errors.As(err, &host) || host.Code != EffectStateUnknown {
					t.Fatalf("fatal replacement: %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			wantEvents := []string{"rollback:first", "rollback:second"}
			wantTrace := []string{
				"effect first/r1.s1 grant=api phase=rollback status=ok",
				"effect second/r1.s1 grant=api phase=rollback status=" + string(status),
			}
			if fatal {
				wantEvents = append(wantEvents, "effect failure")
				wantTrace = append(wantTrace, "effect-failure second/r1 grant=api segment=second/r1.s1 phase=rollback status="+string(status))
			}
			wantEvents = append(wantEvents, reason+":first", "stopped:first", reason+":second", "stopped:second")
			wantTrace = append(wantTrace,
				"stopped first reason=\""+stopReason+"\" discarded=[first/r1]",
				"stopped second reason=\""+stopReason+"\" discarded=[second/r1]",
			)
			releaseEvents(t, events, wantEvents)
			var records []string
			for _, line := range trace {
				if !strings.HasPrefix(line, "> ") {
					records = append(records, line)
				}
			}
			releaseEvents(t, records, wantTrace)
			if fatal && g.Fingerprint() != before {
				t.Fatal("replacement published after fatal cleanup")
			}
			if !fatal && g.Fingerprint() == before {
				t.Fatal("successful replacement kept old code")
			}
		})
	}
}

func TestGrantReleasePanicAndQueuedInputs(t *testing.T) {
	c := New()
	var events []string
	var reentries []error
	d := releaseCapability(t, c, func(ctx GrantContext) {
		_, err := ctx.Group.Pump(releaseNow, PumpOptions{})
		reentries = append(reentries, err)
		ctx.Group.Script("s").Revoke("z")
		events = append(events, ctx.GrantName)
		panic("cleanup cannot refuse")
	})
	g := c.NewGroup(GroupOptions{})
	s := releaseLoad(t, g, "s", releaseSource, map[string]*Grant{"api": d.GrantAll("a"), "z": d.GrantAll("z")})
	s.Stop("done")
	releasePump(t, g)
	releasePump(t, g)
	releaseEvents(t, events[:2], []string{"api", "z"})
	for _, err := range reentries {
		var host *HostError
		if !errors.As(err, &host) || host.Code != ReentrantCall {
			t.Fatal(err)
		}
	}
}

func TestGrantReleaseDoesNotChangeIdentity(t *testing.T) {
	c := New()
	plain := releaseCapability(t, c, nil).GrantAll("binding")
	hooked := releaseCapability(t, c, func(GrantContext) { t.Fatal("unexpected release") }).GrantAll("binding")
	makeGroup := func(grant *Grant) *Group {
		g := c.NewGroup(GroupOptions{Name: "g"})
		releaseLoad(t, g, "s", releaseSource, map[string]*Grant{"api": grant})
		return g
	}
	g := makeGroup(plain)
	if g.Fingerprint() != makeGroup(hooked).Fingerprint() {
		t.Fatal("hook changed Fingerprint")
	}
	save, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = c.Restore(save, RestoreOptions{Grants: func(string, string) *Grant { return hooked }}); err != nil {
		t.Fatal(err)
	}
	if _, err = c.DefineCapability("bad", WithReleaseHook(nil)); err == nil {
		t.Fatal("nil hook accepted")
	}
}

func TestGrantReleaseUsesTrimmedGrants(t *testing.T) {
	c := New()
	var names []string
	d := releaseCapability(t, c, func(ctx GrantContext) { names = append(names, ctx.GrantName) })
	g := c.NewGroup(GroupOptions{})
	s, err := g.Load(LoadOptions{Name: "s", Source: releaseSource, GrantsAsUsed: true, Grants: map[string]*Grant{"api": d.GrantAll("used"), "unused": d.GrantAll("unused")}})
	if err != nil {
		t.Fatal(err)
	}
	s.Stop("done")
	releasePump(t, g)
	releaseEvents(t, names, []string{"api"})
}

func TestScriptNamesInLoadOrderInsideAPump(t *testing.T) {
	c := New()
	var lines, during, released []string
	d, err := c.DefineCapability("probe", Operation{Name: "look", Mode: Immediate, Result: NothingShape, Do: func(call *Call, _ []Value) (Value, error) {
		during = call.Group().ScriptNames()
		return Nothing, nil
	}}, WithReleaseHook(func(ctx GrantContext) { released = ctx.Group.ScriptNames() }))
	if err != nil {
		t.Fatal(err)
	}
	g := c.NewGroup(GroupOptions{Name: "g", Trace: traceFunc(func(line string) { lines = append(lines, line) })})
	z := releaseLoad(t, g, "z", "on go\n  ask probe to look\nend go\n", map[string]*Grant{"probe": d.GrantAll(nil)})
	releaseLoad(t, g, "a", "on go\nend go\n", nil)
	before := len(lines)
	if got := g.ScriptNames(); !reflect.DeepEqual(got, []string{"z", "a"}) {
		t.Fatal(got)
	}
	if len(lines) != before {
		t.Fatalf("ScriptNames recorded %v", lines[before:])
	}
	if _, err := z.Deliver(Message{Name: "go"}); err != nil {
		t.Fatal(err)
	}
	releasePump(t, g)
	if !reflect.DeepEqual(during, []string{"z", "a"}) {
		t.Fatal(during)
	}
	z.Stop("done")
	releasePump(t, g)
	if !reflect.DeepEqual(released, []string{"z", "a"}) {
		t.Fatal(released)
	}
}
