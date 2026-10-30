package notify

// Drives the router through the router kit, corpus/notify-kit/: language-
// neutral sequences of watches, commits, mailbox refusals, Pumps, releases
// and checkpoints with the Deliveries Store Notifications requires. A fresh
// router, an in-memory Store and stand-in Groups run each sequence, as
// impl/ts/tools/notify-kit.ts does.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	talk "northtalk.org/go"
	"northtalk.org/go/internal/toml"
	"northtalk.org/go/internal/value"
)

const kitRoot = "../../../corpus/notify-kit"

type kitSequence struct {
	file, name string
	groups     toml.Table
	limits     WatchLimits
	steps      []toml.Table
}

func limitsOf(s toml.Table) WatchLimits {
	return WatchLimits{Watches: s["watches"].(int64), WatchSize: s["watchSize"].(int64), Pending: s["pending"].(int64), PendingSize: s["pendingSize"].(int64)}
}

func kitSequences(t *testing.T) []kitSequence {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(kitRoot, "*.toml"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no router kit files in %s: %v", kitRoot, err)
	}
	var out []kitSequence
	for _, file := range files {
		b, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		kit, err := toml.ReadTOML(string(b))
		if err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		for _, raw := range kit["sequence"].([]any) {
			seq := raw.(toml.Table)
			s := kitSequence{file: filepath.Base(file), name: seq["name"].(string), groups: kit["groups"].(toml.Table), limits: limitsOf(kit["limits"].(toml.Table))}
			if own, ok := seq["groups"].(toml.Table); ok {
				s.groups = own
			}
			if own, ok := seq["limits"].(toml.Table); ok {
				s.limits = limitsOf(own)
			}
			for _, step := range seq["steps"].([]any) {
				s.steps = append(s.steps, step.(toml.Table))
			}
			out = append(out, s)
		}
	}
	return out
}

// display reads a display-form Value.
func display(source string) talk.Value {
	v, err := value.ParseDisplay(source, nil)
	if err != nil {
		panic(fmt.Sprintf("unreadable display form %s: %v", source, err))
	}
	b, err := value.Encode(v, false)
	if err != nil {
		panic(err)
	}
	out, err := talk.DecodeValue(b, nil)
	if err != nil {
		panic(err)
	}
	return out
}
func listOf(source string) []talk.Value {
	list := display(source)
	out := make([]talk.Value, list.Len())
	for i := range out {
		out[i] = list.Index(i + 1)
	}
	return out
}
func textOf(v talk.Value) string { s, _ := v.AsText(); return s }

func str(step toml.Table, key, fallback string) string {
	if s, ok := step[key].(string); ok {
		return s
	}
	return fallback
}

type mailbox struct {
	gone bool
	room int64 // -1: every Delivery
}

// standIn is a Group as the router sees it: Scripts in load order, mailboxes
// the kit sets, and a save holding its Scripts and their Grants' Stores.
type standIn struct {
	name      string
	scripts   []string
	bindings  map[string]string // "<script>.<grant>" to its Store
	mailboxes map[string]*mailbox
	log       *[]string
	effects   bool
	lastSave  []byte
}

func newStandIn(name string, scripts []string, bindings map[string]string, log *[]string) *standIn {
	return &standIn{name: name, scripts: scripts, bindings: bindings, mailboxes: map[string]*mailbox{}, log: log}
}

func (s *standIn) scriptNames() []string { return append([]string{}, s.scripts...) }
func (s *standIn) deliver(script, message string, payload talk.Value) outcome {
	box := s.mailboxes[script]
	if index(s.scripts, script) == len(s.scripts) || box != nil && box.gone {
		return refused
	}
	if box != nil && box.room == 0 {
		return full
	}
	if box != nil && box.room > 0 {
		box.room--
	}
	*s.log = append(*s.log, fmt.Sprintf("%s %s %s %s", s.name, script, message, payload))
	return admitted
}

type savedStandIn struct {
	Scripts  []string          `json:"scripts"`
	Bindings map[string]string `json:"bindings"`
}

func (s *standIn) save() ([]byte, error) {
	if s.effects {
		s.effects = false
		return nil, &talk.HostError{Code: talk.EffectsPending, Detail: "stand-in"}
	}
	b, err := json.Marshal(savedStandIn{s.scripts, s.bindings})
	s.lastSave = b
	return b, err
}

// stepOutcome is what one step did, or should do, in a comparable form.
type stepOutcome struct {
	Deliveries []string       `json:"deliveries"`
	Error      *string        `json:"error,omitempty"`
	Pending    *bool          `json:"pending,omitempty"`
	Routing    *RoutingResult `json:"routing,omitempty"`
}

func stringList(raw any) []string {
	out := []string{}
	if list, ok := raw.([]any); ok {
		for _, x := range list {
			out = append(out, x.(string))
		}
	}
	return out
}

func expectedOutcome(step toml.Table) stepOutcome {
	out := stepOutcome{Deliveries: []string{}}
	if list, ok := step["deliveries"].([]any); ok {
		for _, raw := range list {
			d := raw.(toml.Table)
			out.Deliveries = append(out.Deliveries, fmt.Sprintf("%s %s %s %s", str(d, "group", "g"), str(d, "script", "a"), d["message"].(string), display(d["payload"].(string))))
		}
	}
	errorText, failing := step["error"].(string)
	if failing {
		e := display(errorText).String()
		out.Error = &e
	}
	if step["do"] == "pumped" {
		pending, _ := step["pending"].(bool)
		out.Pending = &pending
	}
	if step["do"] == "restore" && !failing {
		out.Routing = &RoutingResult{Restored: stringList(step["restored"]), Dropped: stringList(step["dropped"]), Resynced: stringList(step["resynced"])}
	}
	return out
}

func errorDisplay(err error) string {
	var script *talk.ScriptError
	if errors.As(err, &script) {
		code, _ := talk.Text(script.Code)
		fields := []talk.Pair{talk.KV("code", code)}
		if script.Data.Kind() == talk.KindMap {
			fields = append(fields, script.Data.Entries()...)
		}
		m, _ := talk.Map(fields...)
		return m.String()
	}
	var host *talk.HostError
	if errors.As(err, &host) {
		code, _ := talk.Text(string(host.Code))
		m, _ := talk.Map(talk.KV("code", code))
		return m.String()
	}
	panic(err)
}

type kitFailure struct {
	step             int
	expected, actual string
}

type checkpoint struct {
	bytes, save []byte
	from        *standIn
}

// runSequence runs one sequence on a fresh router: the first step that
// differs, if any.
func runSequence(seq kitSequence) *kitFailure {
	limits := seq.limits
	committed := map[string]map[string]talk.Value{}
	revisions := map[string]int{}
	router := New(RouterOptions{
		Limits:   func(string) WatchLimits { return limits },
		Revision: func(store string) string { return fmt.Sprintf("r%d", revisions[store]) },
	})
	log := []string{}
	groups := map[string]*standIn{}
	for name, scripts := range seq.groups {
		groups[name] = newStandIn(name, stringList(scripts), map[string]string{}, &log)
	}
	type segment struct {
		ops   []talk.Value
		store string
	}
	segments := map[string]*segment{}
	checkpoints := map[string]checkpoint{}

	groupOf := func(step toml.Table) *standIn {
		g := groups[str(step, "group", "g")]
		if g == nil {
			panic("no stand-in Group " + str(step, "group", "g"))
		}
		return g
	}
	type owner struct {
		group                  *standIn
		script, grant, binding string
	}
	ownerOf := func(step toml.Table) owner {
		o := owner{groupOf(step), str(step, "script", "a"), str(step, "grant", "store"), str(step, "store", "default")}
		o.group.bindings[o.script+"."+o.grant] = o.binding
		return o
	}

	// apply applies writes to a Store: its changed keys.
	apply := func(store string, ops []talk.Value) []string {
		contents := committed[store]
		if contents == nil {
			contents = map[string]talk.Value{}
			committed[store] = contents
		}
		var order []string
		before, after := map[string]talk.Value{}, map[string]talk.Value{}
		for _, op := range ops {
			kind, key, v := textOf(op.Index(1)), textOf(op.Index(2)), op.Index(3)
			if _, seen := before[key]; !seen {
				order = append(order, key)
				current, ok := contents[key]
				if !ok {
					current = talk.Nothing
				}
				before[key], after[key] = current, current
			}
			switch kind {
			case "set":
				after[key] = v
			case "delete":
				after[key] = talk.Nothing
			case "increment":
				if after[key].Kind() == talk.KindNothing {
					after[key] = v
				} else {
					sum, err := talk.Add(after[key], v)
					if err != nil {
						panic(err)
					}
					after[key] = sum
				}
			default:
				panic("unknown write " + kind)
			}
		}
		var keys []string
		for _, key := range order {
			if Changed(before[key], after[key]) {
				keys = append(keys, key)
				if after[key].Kind() == talk.KindNothing {
					delete(contents, key)
				} else {
					contents[key] = after[key]
				}
			}
		}
		if len(keys) > 0 {
			revisions[store]++
		}
		return keys
	}

	restore := func(step toml.Table) (RoutingResult, error) {
		kept, ok := checkpoints[step["checkpoint"].(string)]
		if !ok {
			panic("no checkpoint " + step["checkpoint"].(string))
		}
		bytes := kept.bytes
		switch step["damage"] {
		case "missing":
			bytes = kept.save
		case "digest":
			// The save is last, so changing its last byte breaks the digest.
			bytes = append([]byte{}, bytes...)
			bytes[len(bytes)-1] ^= 0xff
		}
		as := step["as"].(string)
		bindingOf := func(script, grant string) (string, bool) {
			owned := script + "." + grant
			if grants, ok := step["grants"].(toml.Table); ok {
				if override, ok := grants[owned]; ok {
					s, isText := override.(string)
					return s, isText
				}
			}
			s, ok := kept.from.bindings[owned]
			return s, ok
		}
		variablesOnly, _ := step["variablesOnly"].(bool)
		return router.restore(bytes, func(save []byte) (target, bool, error) {
			var saved savedStandIn
			if err := json.Unmarshal(save, &saved); err != nil {
				return nil, false, &talk.HostError{Code: talk.InvalidSave, Detail: err.Error()}
			}
			bindings := map[string]string{}
			for owned := range saved.Bindings {
				script, grant, _ := strings.Cut(owned, ".")
				if b, ok := bindingOf(script, grant); ok {
					bindings[owned] = b
				}
			}
			g := newStandIn(as, saved.Scripts, bindings, &log)
			groups[as] = g
			return g, variablesOnly, nil
		}, func(script, grant, store string) bool {
			b, ok := bindingOf(script, grant)
			return ok && b == store
		})
	}

	run := func(step toml.Table, out *stepOutcome) error {
		switch step["do"] {
		case "watch":
			args := listOf(step["args"].(string))
			o := ownerOf(step)
			return router.watch(o.group, o.script, o.grant, o.binding, textOf(args[0]), textOf(args[1]), textOf(args[2]))
		case "unwatch":
			o := ownerOf(step)
			router.unwatch(o.group, o.script, o.grant, o.binding, textOf(listOf(step["args"].(string))[0]))
		case "write":
			in := step["in"].(string)
			s := segments[in]
			if s == nil {
				s = &segment{store: str(step, "store", "default")}
				segments[in] = s
			}
			s.ops = append(s.ops, listOf(step["ops"].(string))...)
		case "commit":
			store := str(step, "store", "default")
			var ops []talk.Value
			if in, ok := step["in"].(string); ok {
				if s := segments[in]; s != nil {
					store, ops = s.store, s.ops
				}
				delete(segments, in)
			}
			if raw, ok := step["ops"].(string); ok {
				ops = append(ops, listOf(raw)...)
			}
			return router.Commit(store, func() ([]string, error) { return apply(store, ops), nil })
		case "mailbox":
			box := &mailbox{room: -1}
			box.gone, _ = step["gone"].(bool)
			if room, ok := step["room"].(int64); ok {
				box.room = room
			}
			groupOf(step).mailboxes[str(step, "script", "a")] = box
		case "pumped":
			pending := router.pumped(groupOf(step))
			out.Pending = &pending
		case "release":
			o := ownerOf(step)
			router.release(o.group, o.script, o.grant)
		case "detach":
			router.detach(groupOf(step))
		case "limits":
			limits = limitsOf(step["limits"].(toml.Table))
		case "checkpoint":
			g := groupOf(step)
			g.effects, _ = step["effects"].(bool)
			bytes, err := router.save(g)
			if err != nil {
				return err
			}
			checkpoints[step["as"].(string)] = checkpoint{bytes: bytes, save: g.lastSave, from: g}
		case "revision":
			revisions[str(step, "store", "default")]++
		case "restore":
			routing, err := restore(step)
			if err != nil {
				return err
			}
			out.Routing = &routing
		default:
			panic(fmt.Sprintf("unknown step %v", step["do"]))
		}
		return nil
	}

	for i, step := range seq.steps {
		start := len(log)
		out := stepOutcome{}
		if err := run(step, &out); err != nil {
			e := errorDisplay(err)
			out.Error = &e
		}
		out.Deliveries = append([]string{}, log[start:]...)
		want, _ := json.Marshal(expectedOutcome(step))
		got, _ := json.Marshal(out)
		if string(want) != string(got) {
			return &kitFailure{step: i + 1, expected: string(want), actual: string(got)}
		}
	}
	return nil
}

func TestRouterKit(t *testing.T) {
	sequences := kitSequences(t)
	if len(sequences) < 40 {
		t.Fatalf("the kit has only %d sequences", len(sequences))
	}
	for _, seq := range sequences {
		t.Run(seq.file+": "+seq.name, func(t *testing.T) {
			if f := runSequence(seq); f != nil {
				t.Errorf("step %d\nexpected %s\nactual   %s", f.step, f.expected, f.actual)
			}
		})
	}
}

// A runner that can't fail proves nothing: break expectations in memory and
// check the runner reports each.
func TestRouterKitDetectsDivergence(t *testing.T) {
	mutations := map[string]func(toml.Table){
		"a delivery's payload": func(s toml.Table) {
			d := s["deliveries"].([]any)[0].(toml.Table)
			d["payload"] = strings.Replace(d["payload"].(string), "resync: false", "resync: true", 1)
		},
		"a missing delivery": func(s toml.Table) { delete(s, "deliveries") },
		"an error":           func(s toml.Table) { s["error"] = `{code: "watch limit", limit: "size"}` },
	}
	for what, mutate := range mutations {
		broken := false
		for _, seq := range kitSequences(t) {
			for i, step := range seq.steps {
				if _, ok := step["deliveries"]; !ok && what != "an error" || step["do"] != "commit" {
					continue
				}
				copied := toml.Table{}
				for k, v := range step {
					copied[k] = v
				}
				if d, ok := copied["deliveries"].([]any); ok {
					first := toml.Table{}
					for k, v := range d[0].(toml.Table) {
						first[k] = v
					}
					copied["deliveries"] = append([]any{first}, d[1:]...)
				}
				mutate(copied)
				seq.steps = append(append(append([]toml.Table{}, seq.steps[:i]...), copied), seq.steps[i+1:]...)
				f := runSequence(seq)
				if f == nil || f.step != i+1 {
					t.Fatalf("%s: breaking %s at step %d went unnoticed (%v)", seq.name, what, i+1, f)
				}
				broken = true
				break
			}
			if broken {
				break
			}
		}
		if !broken {
			t.Fatalf("no step to break %s in", what)
		}
	}
}
