package northtalk

import (
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"
)

// releaseBusy opens a scope and enlists a participant, then keeps the Run going.
const releaseBusy = "ask alpha to open\nask alpha to change\nrepeat forever\nend repeat"

type releaseHost struct {
	def, plain *CapabilityDef
	events     []string
	contexts   []GrantContext
	trace      lines
	abandon    func() error
	rollback   EffectStatus
	onRelease  func(GrantContext)
}

func newReleaseHost(t *testing.T, c *Core) *releaseHost {
	t.Helper()
	h := &releaseHost{rollback: EffectOK}
	nothing := func(*Call, []Value) (Value, error) { return Nothing, nil }
	lifecycle := SegmentLifecycle{Begin: effectOK, Commit: effectOK, Rollback: func(ctx SegmentContext) EffectResult {
		h.events = append(h.events, "rollback:"+ctx.GrantName)
		return EffectResult{Status: h.rollback}
	}}
	var err error
	h.def, err = c.DefineCapabilityWith("db", CapabilityOptions{Lifecycle: &lifecycle, Release: func(ctx GrantContext) {
		h.contexts = append(h.contexts, ctx)
		event := fmt.Sprintf("release:%s:%s:%s", ctx.ScriptName, ctx.GrantName, ctx.Reason)
		if slices.ContainsFunc(h.trace, func(l string) bool { return strings.HasPrefix(l, "stopped "+ctx.ScriptName+" ") }) {
			event += ":after stop"
		}
		h.events = append(h.events, event)
		if h.onRelease != nil {
			h.onRelease(ctx)
		}
	}},
		Operation{Name: "change", Mode: Immediate, SegmentBound: true, Result: NothingShape, Cost: Cost{Fuel: 1}, Do: nothing},
		Operation{Name: "open", Mode: Immediate, Result: NothingShape, Cost: Cost{Fuel: 1}, Scope: &ScopeDecl{Opens: "tx", Abandon: "close"}, Do: nothing},
		Operation{Name: "close", Mode: Immediate, Result: NothingShape, Cost: Cost{Fuel: 1}, Scope: &ScopeDecl{Closes: "tx"}, Do: func(call *Call, _ []Value) (Value, error) {
			if call.Automatic() {
				h.events = append(h.events, "abandon:"+call.GrantName())
				if h.abandon != nil {
					return Nothing, h.abandon()
				}
			}
			return Nothing, nil
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	h.plain, err = c.DefineCapability("plain", Operation{Name: "noop", Mode: Immediate, Result: NothingShape, Do: nothing})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func (h *releaseHost) grants() map[string]*Grant {
	return map[string]*Grant{"zeta": h.def.GrantAll("z"), "other": h.plain.GrantAll(nil), "alpha": h.def.GrantAll("a")}
}

func (h *releaseHost) load(t *testing.T, g *Group, name, body string, owner *Object) *Script {
	t.Helper()
	s, err := g.Load(LoadOptions{Name: name, Owner: owner, Grants: h.grants(), Source: "script variable count = 0\non go\n" + body + "\nend go\n"})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

var releaseNow = time.Unix(100, 0).UTC()

func (h *releaseHost) start(t *testing.T, c *Core, body string) (*Group, *Script) {
	t.Helper()
	g := c.NewGroup(GroupOptions{Name: "g", Trace: &h.trace})
	s := h.load(t, g, "s", body, nil)
	s.Deliver(Message{Name: "go"})
	if _, err := g.Pump(releaseNow, PumpOptions{FuelSlice: 40}); err != nil {
		t.Fatal(err)
	}
	return g, s
}

func expectEvents(t *testing.T, h *releaseHost, want ...string) {
	t.Helper()
	if !slices.Equal(h.events, want) {
		t.Fatalf("events\n got %q\nwant %q", h.events, want)
	}
}

func TestReleaseOnStopInNameOrderAfterRollbackBeforeReport(t *testing.T) {
	c := New()
	h := newReleaseHost(t, c)
	g, s := h.start(t, c, releaseBusy)
	s.Stop("requested")
	later := releaseNow.Add(time.Second)
	if _, err := g.Pump(later, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	expectEvents(t, h, "abandon:alpha", "rollback:alpha", "release:s:alpha:stop", "release:s:zeta:stop")
	ctx := h.contexts[0]
	if ctx.Group != g || ctx.ScriptName != "s" || ctx.GrantName != "alpha" || ctx.Binding != "a" || !ctx.Now.Equal(later) || ctx.Reason != ReleaseStop {
		t.Fatal(ctx)
	}
	s.Stop("again")
	if _, err := g.Pump(later, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if len(h.events) != 4 {
		t.Fatal(h.events)
	}
}

func TestReleaseOnOwnerDisposal(t *testing.T) {
	c := New()
	h := newReleaseHost(t, c)
	g := c.NewGroup(GroupOptions{Name: "g", Trace: &h.trace})
	kind, err := c.DefineObjectKind(ObjectKindDef{Name: "widget"})
	if err != nil {
		t.Fatal(err)
	}
	owner, err := g.Object(kind, "w", nil)
	if err != nil {
		t.Fatal(err)
	}
	h.load(t, g, "s", releaseBusy, owner)
	if err := g.Dispose(owner); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Pump(releaseNow, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	expectEvents(t, h, "release:s:alpha:stop", "release:s:zeta:stop")
}

func TestReleaseOnFatalEffectUncertaintyStopsEveryScript(t *testing.T) {
	c := New()
	h := newReleaseHost(t, c)
	h.rollback = EffectFailed
	g, s := h.start(t, c, releaseBusy)
	h.load(t, g, "t", "", nil)
	s.Stop("requested")
	if _, err := g.Pump(releaseNow, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	expectEvents(t, h, "abandon:alpha", "rollback:alpha", "release:s:alpha:stop", "release:s:zeta:stop", "release:t:alpha:stop", "release:t:zeta:stop")
}

func TestReleaseOnSuccessfulReloadOnly(t *testing.T) {
	c := New()
	h := newReleaseHost(t, c)
	var reentry error
	h.onRelease = func(ctx GrantContext) { _, reentry = ctx.Group.Save() }
	g, s := h.start(t, c, releaseBusy)
	if _, err := s.Reload("on", CarryVariables); err == nil {
		t.Fatal("bad Reload accepted")
	}
	expectEvents(t, h)
	if _, err := s.Reload("script variable count = 0\non go\nask alpha to change\nend go\n", CarryVariables); err != nil {
		t.Fatal(err)
	}
	expectEvents(t, h, "abandon:alpha", "rollback:alpha", "release:s:alpha:reload", "release:s:zeta:reload")
	if host, ok := reentry.(*HostError); !ok || host.Code != ReentrantCall {
		t.Fatal(reentry)
	}
	h.onRelease = nil
	// Extend, Save and Restore never release.
	if err := s.Extend("on more\nend more\n"); err != nil {
		t.Fatal(err)
	}
	saved, err := g.Save()
	if err != nil {
		t.Fatal(err)
	}
	grants := h.grants()
	if _, _, err := c.Restore(saved, RestoreOptions{Grants: func(_, name string) *Grant { return grants[name] }}); err != nil {
		t.Fatal(err)
	}
	if len(h.events) != 4 {
		t.Fatal(h.events)
	}
}

func TestReleaseOnFailedReloadCleanupIsStop(t *testing.T) {
	c := New()
	h := newReleaseHost(t, c)
	h.rollback = EffectFailed
	_, s := h.start(t, c, releaseBusy)
	if _, err := s.Reload("script variable count = 9\n", CarryVariables); err == nil {
		t.Fatal("Reload succeeded")
	}
	expectEvents(t, h, "abandon:alpha", "rollback:alpha", "release:s:alpha:stop", "release:s:zeta:stop")
}

func TestReleaseOnLibraryReplacement(t *testing.T) {
	c := New()
	h := newReleaseHost(t, c)
	g := c.NewGroup(GroupOptions{Name: "g"})
	library := func(source string) *Library {
		l, err := c.CompileLibrary(LibrarySource{Name: "user", Source: source}, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		return l
	}
	if err := g.AddLibrary(library("function answer\nreturn 1\nend answer\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Load(LoadOptions{Name: "s", Grants: map[string]*Grant{"alpha": h.def.GrantAll("a")}, Source: "use answer from user\non go\nreturn answer()\nend go\n"}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.ReplaceLibrary(library("function other\nend other\n"), CarryVariables); err == nil {
		t.Fatal("bad replacement accepted")
	}
	expectEvents(t, h)
	if _, err := g.ReplaceLibrary(library("function answer\nreturn 2\nend answer\n"), CarryVariables); err != nil {
		t.Fatal(err)
	}
	expectEvents(t, h, "release:s:alpha:reload")
}

func TestReleaseOnFirstRevocationWhenDrained(t *testing.T) {
	c := New()
	h := newReleaseHost(t, c)
	g, s := h.start(t, c, "")
	s.Revoke("alpha")
	expectEvents(t, h)
	pump := func() {
		if _, err := g.Pump(releaseNow, PumpOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	pump()
	expectEvents(t, h, "release:s:alpha:revoke")
	s.Revoke("alpha")
	s.Revoke("missing")
	s.Revoke("other")
	pump()
	expectEvents(t, h, "release:s:alpha:revoke")
	// A later Stop includes the revoked Grant.
	s.Stop("requested")
	pump()
	expectEvents(t, h, "release:s:alpha:revoke", "release:s:alpha:stop", "release:s:zeta:stop")
}

func TestReleaseOnDisableAfterFailedAbandonment(t *testing.T) {
	c := New()
	h := newReleaseHost(t, c)
	h.abandon = func() error { return &ScriptError{Code: "broken"} }
	g, s := h.start(t, c, releaseBusy)
	s.Stop("requested")
	if _, err := g.Pump(releaseNow, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	expectEvents(t, h, "abandon:alpha", "release:s:alpha:disable", "rollback:alpha", "release:s:alpha:stop", "release:s:zeta:stop")
}

func TestReleasePanicsAreIgnoredAndQueuedInputsLandLater(t *testing.T) {
	c := New()
	h := newReleaseHost(t, c)
	g, s := h.start(t, c, releaseBusy)
	other := h.load(t, g, "t", "put 1 into count", nil)
	h.onRelease = func(GrantContext) {
		other.Deliver(Message{Name: "go"})
		panic("ignored")
	}
	s.Stop("requested")
	if _, err := g.Pump(releaseNow, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
	if got := slices.DeleteFunc(slices.Clone(h.events), func(e string) bool { return !strings.HasPrefix(e, "release:") }); !slices.Equal(got, []string{"release:s:alpha:stop", "release:s:zeta:stop"}) {
		t.Fatal(got)
	}
	if _, err := g.Pump(releaseNow, PumpOptions{}); err != nil {
		t.Fatal(err)
	}
}

func TestReleaseHookDefinitionAndIdentity(t *testing.T) {
	c := New()
	lifecycle := SegmentLifecycle{Begin: effectOK, Commit: effectOK, Rollback: effectOK}
	if _, err := c.DefineCapabilityWith("bad", CapabilityOptions{Lifecycle: &lifecycle, Coordinator: func(any) *SegmentLifecycle { return &lifecycle }}); err == nil {
		t.Fatal("lifecycle and coordinator both accepted")
	}
	h := newReleaseHost(t, c)
	ops := []Operation{}
	for _, name := range []string{"change", "close", "open"} {
		ops = append(ops, h.def.ops[name])
	}
	without, err := c.DefineSegmentCapability("db", lifecycle, ops...)
	if err != nil {
		t.Fatal(err)
	}
	fingerprint := func(d *CapabilityDef) [32]byte {
		g := c.NewGroup(GroupOptions{Name: "g"})
		if _, err := g.Load(LoadOptions{Name: "s", Grants: map[string]*Grant{"alpha": d.GrantAll("a")}}); err != nil {
			t.Fatal(err)
		}
		return g.Fingerprint()
	}
	if fingerprint(h.def) != fingerprint(without) {
		t.Fatal("release hook changed identity")
	}
}
