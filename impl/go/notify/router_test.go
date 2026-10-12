package notify

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// The router on real Groups. `store` here offers only `watch`, so a watch is
// registered through a real Call and released by the real release hook.

var now = time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)

var roomy = WatchLimits{Watches: 100, WatchSize: 65536, Pending: 1000, PendingSize: 1048576}

func setup(t *testing.T, core *talk.Core, revision func(string) string) (*Router, *talk.CapabilityDef) {
	t.Helper()
	return setupWith(t, core, RouterOptions{Revision: revision})
}

// setupWith is setup with the given options, and roomy limits.
func setupWith(t *testing.T, core *talk.Core, o RouterOptions) (*Router, *talk.CapabilityDef) {
	t.Helper()
	o.Limits = func(string) WatchLimits { return roomy }
	router := New(o)
	def, err := core.DefineCapability("store", talk.Operation{
		Name: "watch", Mode: talk.Immediate,
		Args:   []talk.Shape{talk.TextShape, talk.TextShape, talk.TextShape},
		Result: talk.NothingShape,
		Do: func(c *talk.Call, args []talk.Value) (talk.Value, error) {
			return talk.Nothing, router.Watch(c, textOf(args[0]), textOf(args[1]), textOf(args[2]))
		},
	}, talk.WithReleaseHook(router.Release))
	if err != nil {
		t.Fatal(err)
	}
	return router, def
}

func watcher(watch string) string {
	return `script variable seen = []
on start
  ask scores to watch ` + watch + `
end start
on changed change
  put the "keys" of change after seen
end changed
on storeChanged change
  put the resync of change after seen
end storeChanged`
}

func load(t *testing.T, g *talk.Group, name, source string, grants map[string]*talk.Grant, limits talk.Limits) *talk.Script {
	t.Helper()
	s, err := g.Load(talk.LoadOptions{Name: name, Source: source, Grants: grants, Limits: limits})
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func deliver(t *testing.T, s *talk.Script, message string) {
	t.Helper()
	if _, err := s.Deliver(talk.Message{Name: message}); err != nil {
		t.Fatal(err)
	}
}
func pump(t *testing.T, g *talk.Group) {
	t.Helper()
	if _, err := g.Pump(now, talk.PumpOptions{}); err != nil {
		t.Fatal(err)
	}
}
func seen(g *talk.Group, script string) string {
	for _, s := range g.Inspect().Scripts {
		if s.Name == script {
			for _, v := range s.Vars {
				if v.Key == "seen" {
					return v.Val.String()
				}
			}
		}
	}
	return "<none>"
}
func commit(t *testing.T, r *Router, store string, keys ...string) {
	t.Helper()
	if err := r.Commit(store, func() ([]string, error) { return keys, nil }); err != nil {
		t.Fatal(err)
	}
}
func revisionOf(s string) func(string) string { return func(string) string { return s } }

type traceLines struct{ lines []string }

func (t *traceLines) Record(line string) { t.lines = append(t.lines, line) }

func TestPayloadSizes(t *testing.T) {
	if got := markerSize("store", "w", ""); got != 240 {
		t.Fatalf("marker size %d; want 240", got)
	}
	if got := sizeOf(payloadOf("store", "w", "", []string{"k"}, false)); got != 265 {
		t.Fatalf("ordinary size %d; want 265", got)
	}
	if got := watchSize("w", "", "storeChanged"); got != 61 {
		t.Fatalf("watch size %d; want 61", got)
	}
}

func TestWatchLimitError(t *testing.T) {
	e := watchLimit("pending")
	if e.Code != "watch limit" || e.Data.String() != `{limit: "pending"}` || e.Message != `The Store's "pending" limit for watches would be exceeded` {
		t.Fatalf("%q %s %q", e.Code, e.Data, e.Message)
	}
}

func TestChanged(t *testing.T) {
	one, two := talk.Int(1), talk.Int(2)
	x, _ := talk.Text("x")
	for _, c := range []struct {
		before, after talk.Value
		want          bool
	}{{talk.Nothing, talk.Nothing, false}, {one, one, false}, {one, two, true}, {talk.Nothing, one, true}, {one, talk.Nothing, true}, {one, x, true}} {
		if got := Changed(c.before, c.after); got != c.want {
			t.Errorf("Changed(%s, %s) = %v", c.before, c.after, got)
		}
	}
}

func TestCommitDeliversInLoadOrderAndRetriesAFullMailbox(t *testing.T) {
	core := talk.New()
	router, def := setup(t, core, revisionOf("r0"))
	trace := &traceLines{}
	group := core.NewGroup(talk.GroupOptions{Name: "g", Trace: trace})
	for _, name := range []string{"b", "a"} {
		s := load(t, group, name, watcher(`"w", "", "changed"`), map[string]*talk.Grant{"scores": def.GrantAll("default")}, talk.Limits{MailboxDepth: 1})
		deliver(t, s, "start")
	}
	pump(t, group)
	trace.lines = nil
	commit(t, router, "default", "k")
	// Each mailbox holds one Delivery, so the next commit is held.
	commit(t, router, "default", "j")
	if !router.Pumped(group) {
		t.Fatal("no pending work after a refused commit")
	}
	pump(t, group)
	// The Pump records accepted Deliveries in the order they were made: the
	// router delivered to b, loaded first, before a.
	var accepted []string
	for _, line := range trace.lines {
		if strings.HasPrefix(line, "> deliver d") {
			accepted = append(accepted, strings.Join(strings.Fields(line)[2:4], " "))
		}
	}
	if !reflect.DeepEqual(accepted, []string{"d3 to=b", "d4 to=a"}) {
		t.Fatalf("deliveries not in load order: %q", trace.lines)
	}
	if got := seen(group, "b"); got != `[["k"]]` {
		t.Fatal(got)
	}
	if router.Pumped(group) {
		t.Fatal("pending work after the retry")
	}
	pump(t, group)
	for _, name := range []string{"a", "b"} {
		if got := seen(group, name); got != `[["k"], ["j"]]` {
			t.Fatalf("%s: %s", name, got)
		}
	}
}

func TestAdmittedIsToldOfEachAdmissionButNotARefusal(t *testing.T) {
	core := talk.New()
	var told []*talk.Group
	router, def := setupWith(t, core, RouterOptions{Revision: revisionOf("r0"), Admitted: func(g *talk.Group) { told = append(told, g) }})
	group := core.NewGroup(talk.GroupOptions{Name: "g"})
	s := load(t, group, "a", watcher(`"w", "", "changed"`), map[string]*talk.Grant{"scores": def.GrantAll("default")}, talk.Limits{MailboxDepth: 1})
	deliver(t, s, "start")
	pump(t, group)
	commit(t, router, "default", "k")
	if len(told) != 1 || told[0] != group {
		t.Fatal(told)
	}
	// The full mailbox refuses the next one, which the router holds.
	commit(t, router, "default", "j")
	if len(told) != 1 {
		t.Fatal(told)
	}
	pump(t, group)
	router.Pumped(group)
	if len(told) != 2 || told[1] != group {
		t.Fatal(told)
	}
}

func TestStopReleasesWatches(t *testing.T) {
	core := talk.New()
	router, def := setup(t, core, revisionOf("r0"))
	group := core.NewGroup(talk.GroupOptions{Name: "g"})
	s := load(t, group, "a", watcher(`"w", "", "changed"`), map[string]*talk.Grant{"scores": def.GrantAll("default")}, talk.Limits{})
	deliver(t, s, "start")
	pump(t, group)
	if len(router.stores["default"]) != 1 {
		t.Fatal("watch not registered")
	}
	s.Stop("done")
	pump(t, group)
	commit(t, router, "default", "k")
	if mailbox := group.Inspect().Scripts[0].Mailbox; len(mailbox) != 0 || len(router.groups) != 0 || len(router.stores) != 0 {
		t.Fatalf("mailbox %v, groups %d, stores %d", mailbox, len(router.groups), len(router.stores))
	}
}

func TestCheckpointRestoresThroughCoreRestore(t *testing.T) {
	core := talk.New()
	revision := "r0"
	var mu sync.Mutex
	router, def := setup(t, core, func(string) string { mu.Lock(); defer mu.Unlock(); return revision })
	group := core.NewGroup(talk.GroupOptions{Name: "g"})
	s := load(t, group, "a", watcher(`"w", "", "storeChanged"`), map[string]*talk.Grant{"scores": def.GrantAll("default")}, talk.Limits{})
	deliver(t, s, "start")
	pump(t, group)
	checkpoint, err := router.Save(group)
	if err != nil {
		t.Fatal(err)
	}
	router.Detach(group)
	options := talk.RestoreOptions{Name: "g", Grants: func(string, string) *talk.Grant { return def.GrantAll("default") }}
	bare, err := group.Save()
	if err != nil {
		t.Fatal(err)
	}
	damaged := append([]byte{}, checkpoint...)
	damaged[len(damaged)-1] ^= 0xff
	for name, bytes := range map[string][]byte{"bare save": bare, "digest": damaged, "empty": nil} {
		_, _, _, err := router.Restore(core, bytes, options)
		var host *talk.HostError
		if !errors.As(err, &host) || host.Code != talk.InvalidCheckpoint {
			t.Fatalf("%s: %v", name, err)
		}
		if len(router.groups) != 0 {
			t.Fatalf("%s registered a watch", name)
		}
	}
	mu.Lock()
	revision = "r1"
	mu.Unlock()
	restored, _, routing, err := router.Restore(core, checkpoint, options)
	if err != nil {
		t.Fatal(err)
	}
	want := RoutingResult{Restored: []string{"a.scores.w"}, Dropped: []string{}, Resynced: []string{"a.scores.w"}}
	if !reflect.DeepEqual(routing, want) {
		t.Fatalf("%+v", routing)
	}
	pump(t, restored)
	if got := seen(restored, "a"); got != "[true]" {
		t.Fatal(got)
	}
	commit(t, router, "default", "k")
	pump(t, restored)
	if got := seen(restored, "a"); got != "[true, false]" {
		t.Fatal(got)
	}
}

func TestAGrantReboundToAnotherStoreIsDropped(t *testing.T) {
	core := talk.New()
	router, def := setup(t, core, revisionOf("r0"))
	group := core.NewGroup(talk.GroupOptions{Name: "g"})
	s := load(t, group, "a", watcher(`"w", "", "changed"`), map[string]*talk.Grant{"scores": def.GrantAll("default")}, talk.Limits{})
	deliver(t, s, "start")
	pump(t, group)
	checkpoint, err := router.Save(group)
	if err != nil {
		t.Fatal(err)
	}
	_, _, routing, err := router.Restore(core, checkpoint, talk.RestoreOptions{Name: "g", Grants: func(string, string) *talk.Grant { return def.GrantAll("elsewhere") }})
	if err != nil {
		t.Fatal(err)
	}
	want := RoutingResult{Restored: []string{}, Dropped: []string{"a.scores.w"}, Resynced: []string{}}
	if !reflect.DeepEqual(routing, want) {
		t.Fatalf("%+v", routing)
	}
}

// Groups pumped on their own goroutines while others commit: run with -race.
func TestConcurrentCommitsAndPumps(t *testing.T) {
	core := talk.New()
	router, def := setup(t, core, revisionOf("r0"))
	const groups, commits = 4, 50
	var wg sync.WaitGroup
	ready := make(chan *talk.Group, groups)
	for i := range groups {
		wg.Add(1)
		go func() {
			defer wg.Done()
			group := core.NewGroup(talk.GroupOptions{Name: fmt.Sprintf("g%d", i)})
			store := []string{"default", "other"}[i%2]
			s, err := group.Load(talk.LoadOptions{Name: "a", Source: watcher(`"w", "", "changed"`), Grants: map[string]*talk.Grant{"scores": def.GrantAll(store)}, Limits: talk.Limits{MailboxDepth: 2}})
			if err != nil {
				t.Error(err)
				return
			}
			s.Deliver(talk.Message{Name: "start"})
			group.Pump(now, talk.PumpOptions{})
			ready <- group
			for range commits * 2 {
				group.Pump(now, talk.PumpOptions{})
				router.Pumped(group)
			}
		}()
	}
	for range groups {
		<-ready
	}
	for i := range commits {
		wg.Add(2)
		for _, store := range []string{"default", "other"} {
			go func() {
				defer wg.Done()
				if err := router.Commit(store, func() ([]string, error) { return []string{fmt.Sprint(i)}, nil }); err != nil {
					t.Error(err)
				}
			}()
		}
	}
	wg.Wait()
}

func TestAFailedCommitRoutesNothing(t *testing.T) {
	r := New(RouterOptions{Limits: func(string) WatchLimits { return roomy }, Revision: revisionOf("r0")})
	var log []string
	g := newStandIn("g", []string{"a"}, map[string]string{}, &log)
	if err := r.watch(g, "a", "store", "default", "w", "", "storeChanged"); err != nil {
		t.Fatal(err)
	}
	failed := errors.New("refused")
	if err := r.Commit("default", func() ([]string, error) { return []string{"k"}, failed }); err != failed || len(log) != 0 {
		t.Fatalf("%v %v", err, log)
	}
}
