package peer

// Drives the router through the peer kit, corpus/peer-kit/: language-neutral
// sequences of exposes, unexposes, Remote Sends, releases and detaches, with
// the Deliveries and failures chapter 9's Peer Router obligations require. A
// fresh router and stand-in Groups run each sequence, as
// impl/ts/tools/peer-kit.ts does.

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	talk "northtalk.org/go"
	"northtalk.org/go/internal/toml"
	"northtalk.org/go/internal/value"
)

const kitRoot = "../../../corpus/peer-kit"

type kitSequence struct {
	file, name string
	groups     toml.Table
	steps      []toml.Table
}

func kitSequences(t *testing.T) []kitSequence {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(kitRoot, "*.toml"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no peer kit files in %s: %v", kitRoot, err)
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
			s := kitSequence{file: filepath.Base(file), name: seq["name"].(string), groups: kit["groups"].(toml.Table)}
			if own, ok := seq["groups"].(toml.Table); ok {
				s.groups = own
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

func str(step toml.Table, key, fallback string) string {
	if s, ok := step[key].(string); ok {
		return s
	}
	return fallback
}

// standIn is a Group as the router sees it: Scripts that log each Delivery
// and Request they accept, and Peers that are text naming their id.
type standIn struct {
	name    string
	scripts []string
	log     *[]string
}

func (s *standIn) peer(id string) (talk.Value, error) { return talk.Text("peer " + id) }

func (s *standIn) accept(script, kind string, m talk.Message) (talk.DeliveryID, error) {
	found := false
	for _, n := range s.scripts {
		found = found || n == script
	}
	if !found {
		return "", errNoScript
	}
	*s.log = append(*s.log, fmt.Sprintf("%s %s %s %s %s", s.name, script, kind, m.Name, talk.List(m.Args...)))
	return talk.DeliveryID(fmt.Sprintf("d%d", len(*s.log))), nil
}

func (s *standIn) deliver(script string, m talk.Message) (talk.DeliveryID, error) {
	return s.accept(script, "deliver", m)
}

// The kit never settles a Request: what it observes is that one arrived.
func (s *standIn) request(script string, m talk.Message) (talk.DeliveryID, func(func(talk.Value, *talk.ScriptError)), error) {
	id, err := s.accept(script, "request", m)
	return id, func(func(talk.Value, *talk.ScriptError)) {}, err
}

func errorDisplay(e *talk.ScriptError) string {
	pairs := []talk.Pair{{Key: "code", Val: must(talk.Text(e.Code))}}
	if e.Data.Kind() == talk.KindMap {
		pairs = append(pairs, e.Data.Entries()...)
	}
	return must(talk.Map(pairs...)).String()
}

func must(v talk.Value, err error) talk.Value {
	if err != nil {
		panic(err)
	}
	return v
}

type outcome struct {
	deliveries []string
	err        string
	peer       string
}

func (o outcome) String() string {
	return fmt.Sprintf("deliveries %q, error %q, peer %q", o.deliveries, o.err, o.peer)
}

func expected(step toml.Table) outcome {
	var o outcome
	if ds, ok := step["deliveries"].([]any); ok {
		for _, raw := range ds {
			d := raw.(toml.Table)
			o.deliveries = append(o.deliveries, fmt.Sprintf("%s %s %s %s %s",
				str(d, "group", "g"), str(d, "script", "a"), d["kind"], d["message"], display(d["args"].(string))))
		}
	}
	if e, ok := step["error"].(string); ok {
		o.err = display(e).String()
	}
	if step["do"] == "expose" && o.err == "" {
		o.peer = "new"
		if same, ok := step["same"].(string); ok {
			o.peer = "same " + same
		}
	}
	return o
}

// runSequence runs one sequence on a fresh router; the first step that
// differs, if any.
func runSequence(s kitSequence) (int, outcome, outcome, bool) {
	var log []string
	r := &Router{key: strings.Repeat("ab", 32), exposures: map[string]exposure{},
		names: map[string]string{}, members: map[target]*member{}}
	groups := map[string]*standIn{}
	names := make([]string, 0, len(s.groups))
	for name := range s.groups {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		var scripts []string
		for _, sc := range s.groups[name].([]any) {
			scripts = append(scripts, sc.(string))
		}
		g := &standIn{name: name, scripts: scripts, log: &log}
		groups[name] = g
		r.attach(g, talk.Nothing)
	}
	peers := map[string]string{} // kept Peer name to its id
	for i, step := range s.steps {
		start := len(log)
		var got outcome
		g := groups[str(step, "group", "g")]
		o := owner{g, str(step, "script", "a"), str(step, "grant", "peer")}
		c := call{owner: o, binding: Binding{},
			answer: func(v talk.Value) {
				if step["do"] != "expose" {
					return
				}
				text, _ := v.AsText()
				id := strings.TrimPrefix(text, "peer ")
				got.peer = "new"
				for name, known := range peers {
					if known == id {
						got.peer = "same " + name
					}
				}
				if as, ok := step["as"].(string); ok {
					peers[as] = id
				}
			},
			fail: func(e *talk.ScriptError) { got.err = errorDisplay(e) },
		}
		var err error
		switch step["do"] {
		case "expose":
			err = r.expose(c, str(step, "name", ""))
		case "unexpose":
			r.unexpose(c, str(step, "name", ""), peers[str(step, "peer", "")])
		case "post", "call":
			err = r.send(c, peers[step["peer"].(string)], step["message"].(string), listOf(str(step, "args", "[]")), step["do"] == "call")
		case "release":
			r.release(o, talk.ReleaseReason(step["reason"].(string)))
		case "detach":
			r.detach(g)
		default:
			panic(fmt.Sprintf("unknown step %v", step["do"]))
		}
		if err != nil {
			got.err = err.Error()
		}
		got.deliveries = log[start:]
		want := expected(step)
		if fmt.Sprint(want) != fmt.Sprint(got) {
			return i + 1, want, got, false
		}
	}
	return 0, outcome{}, outcome{}, true
}

func TestPeerKit(t *testing.T) {
	sequences := kitSequences(t)
	if len(sequences) < 10 {
		t.Fatalf("the kit has %d sequences", len(sequences))
	}
	for _, s := range sequences {
		t.Run(s.file+": "+s.name, func(t *testing.T) {
			if step, want, got, ok := runSequence(s); !ok {
				t.Fatalf("step %d:\nwant %v\n got %v", step, want, got)
			}
		})
	}
}
