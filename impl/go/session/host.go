// Package session is chapter 12's Session Host for Go. Its Session Commands,
// observation, `:describe`, inspection and Transcript replay are the Zig
// Session Host's, which the embedded reactor serves as `session-v1` (ADR
// 0180): each Host runs one guest, which owns the session's Group. Go keeps
// the Session Driver's side: its Environment supplies the Clock, files and
// live Host Objects, and receives the Transcript and the Trace.
package session

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	talk "northtalk.org/go"
	"northtalk.org/go/internal/sessionio"
	v "northtalk.org/go/internal/value"
)

// Item is one Transcript record. Kind is input, read, clock, answer, envelope,
// comment or output; an input's continuation lines are folded into Text with
// LF.
type Item struct {
	Kind, Text, Call string
	At               time.Time
}

// Environment supplies host effects. Callbacks run synchronously; callers
// serialize the Host's calls. Record receives every Transcript Item the
// session makes, printed lines included, and Trace its Group's Trace lines.
//
// Objects declares live Host Objects, whose property and collection
// callbacks the session calls through Go; ResolveObject answers a live
// Restore. ObjectTranscript is a recorded Transcript whose crossings and
// Restores answer the session's instead, as a replay does. Now reads the
// real Clock for each Host call. ReadFile and ReadStoreFile read the file
// `:library`, `:script`, `:fix` or `:store load` names, before the command
// goes to the session with the file's lines; WriteFile and WriteStoreFile
// write what `:export` and `:store save` make.
type Environment struct {
	Objects          func(*Objects) map[string]*talk.Object
	ResolveObject    func(kind, id string) (any, bool)
	ObjectTranscript []Item
	Now              func() time.Time
	Record           func(Item)
	Trace            func(string)
	ReadFile         func(string) (string, error)
	WriteFile        func(directory, file, source string) error
	ReadStoreFile    func(path string) (string, error)
	WriteStoreFile   func(path, source string) error
}

// Waiting is what the Session Host waits for: prompt, read, user (with the
// prompt's Call and Prompt) or deadline (with At).
type Waiting struct {
	Kind   string
	At     time.Time
	Call   string
	Prompt *Prompt
}

// Host is one session, served by its own guest.
type Host struct {
	env     Environment
	guest   *sessionio.Guest
	objects *Objects
	replay  *replayed
	waiting Waiting
	// The next deadline under a real Clock.
	deadline time.Time
	virtual  bool
	started  bool
	// The input in flight, which a write need belongs to.
	command string
	// The last envelope the session recorded: a Host action's, with its reply.
	lastEnvelope string
}

// New opens a session on a new guest. It panics if the embedded reactor
// can't serve one.
func New(env Environment) *Host {
	if env.Now == nil {
		env.Now = time.Now
	}
	guest, err := sessionio.OpenGuest()
	if err != nil {
		panic(err)
	}
	h := &Host{env: env, guest: guest, waiting: Waiting{Kind: "prompt"}}
	if env.ObjectTranscript != nil {
		h.replay = newReplayed(env.ObjectTranscript)
	}
	fields := map[string]any{}
	if h.replay != nil && h.replay.declares() {
		// A replay's declarations are its own envelopes.
		fields["objects"] = []any{}
	}
	if env.Objects != nil {
		h.objects = newObjects(h)
		bindings := env.Objects(h.objects)
		fields["objects"] = h.objects.opening(bindings)
	}
	h.call("session-open", fields)
	return h
}

func (h *Host) Started() bool           { return h.started }
func (h *Host) VirtualClock() bool      { return h.virtual }
func (h *Host) Waiting() Waiting        { return h.waiting }
func (h *Host) NextDeadline() time.Time { return h.deadline }

// Close ends the session and its guest.
func (h *Host) Close() {
	if h.guest != nil {
		h.guest.Exchange("session-close", nil, 0)
		h.guest.Close()
		h.guest = nil
	}
}

// Input is one Entry or Session Command, with any further lines after LF. A
// command that names a file is sent with the file's lines in its place.
func (h *Host) Input(source string) []string {
	s := strings.TrimRight(source, "\n")
	first, more, multiline := strings.Cut(s, "\n")
	lines := []any{}
	if multiline {
		for _, l := range strings.Split(more, "\n") {
			lines = append(lines, l)
		}
	} else {
		named, ok := h.withFile(first)
		if !ok {
			return []string{"! bad arguments"}
		}
		first, lines = named.first, named.more
	}
	h.started = true
	h.command = first
	defer func() { h.command = "" }()
	fields := map[string]any{"input": first}
	if len(lines) > 0 {
		fields["more"] = lines
	}
	return h.timed("session-input", fields)
}

// Read gives a `read` the session waits for its line.
func (h *Host) Read(line string) []string {
	if h.waiting.Kind != "read" {
		return nil
	}
	return h.timed("session-input", map[string]any{"line": line})
}

// AnswerPrompt answers the user prompt the session waits for with what the
// person gave: a boolean, the chosen item or items, the entered text, or
// Nothing.
func (h *Host) AnswerPrompt(answer talk.Value) []string {
	if h.waiting.Kind != "user" {
		return nil
	}
	return h.timed("session-input", map[string]any{"answer": map[string]any{"shown": answer.String(), "fail": false}})
}

// ReplayAnswer gives a Transcript's `~` line to the session: a prompt's
// answer answers it, and a `user busy` the session recorded itself is
// skipped.
func (h *Host) ReplayAnswer(item Item) (bool, []string) {
	if h.waiting.Kind == "user" && h.waiting.Call == item.Call {
		shown, fail := strings.CutPrefix(item.Text, "fail ")
		return true, h.timed("session-input", map[string]any{"answer": map[string]any{"shown": shown, "fail": fail}})
	}
	return strings.HasPrefix(item.Text, `fail {code: "user busy"`), nil
}

// Tick is a Pump at a deadline.
func (h *Host) Tick() []string {
	return h.timed("session-pump", map[string]any{})
}

// NeedsMore reports whether source, the lines a Driver has collected, waits
// for more before it is a whole Entry or Session Command, as the session's
// own names read it.
func (h *Host) NeedsMore(source string) bool {
	ok := h.query("session-complete", map[string]any{"text": source})
	var r struct {
		Complete bool `json:"complete"`
	}
	if err := json.Unmarshal(ok, &r); err != nil {
		panic(err)
	}
	return !r.Complete
}

// Inspect is the session Group's Inspection, as a Trace Case ends: its
// snapshot goes to the Trace, and nothing is recorded.
func (h *Host) Inspect() talk.Inspection {
	r := h.exchange("session-inspect", map[string]any{}, 0)
	h.records(r)
	x, err := sessionio.DecodeInspection(r.OK, h.objectByID)
	if err != nil {
		panic(err)
	}
	return x.(talk.Inspection)
}

// ReplayObjectItem gives the session a recorded envelope between Host calls:
// an object declaration, or a Host action, which the session performs again.
func (h *Host) ReplayObjectItem(index int) {
	item := h.env.ObjectTranscript[index]
	e, err := ParseEnvelope(item.Text)
	if err != nil {
		panic(err)
	}
	text := item.Text
	if envelopeText(e["type"]) == "input" {
		text = requestOnly(e)
	} else if !declaration(e) {
		panic(fmt.Errorf("Malformed Transcript: %s between Host calls", envelopeText(e["type"])))
	}
	h.timed("session-input", map[string]any{"envelope": text})
}

// FinishObjectReplay ends a replay. The session checks each envelope as it
// comes, so there is nothing left to check.
func (h *Host) FinishObjectReplay() {}

// declaration reports whether e declares Host Objects.
func declaration(e Envelope) bool {
	switch envelopeText(e["type"]) {
	case "kind", "object", "setup":
		return true
	}
	return false
}

// requestOnly is a recorded Host action as an embedder hands it: its request
// alone, whose reply the session finds itself.
func requestOnly(e Envelope) string {
	return writeEnvelope(Envelope{"type": rawJSON("input"), "request": e["request"]})
}

// ------------------------------------------------------------ files

type input struct {
	first string
	more  []any
}

// withFile reads the file a command names, as the Zig REPL does: the
// command goes without the path, and with the file's lines. False when the
// file can't be read.
func (h *Host) withFile(first string) (input, bool) {
	words := strings.Fields(first)
	read := h.env.ReadFile
	var path string
	switch {
	case len(words) == 4 && (words[0] == ":library" || words[0] == ":script"):
		path, words = words[3], words[:3]
	case len(words) == 3 && words[0] == ":fix":
		path, words = words[2], words[:2]
	// `:store load <path> [<store>]`
	case len(words) >= 3 && len(words) <= 4 && words[0] == ":store" && words[1] == "load":
		path, read = words[2], h.env.ReadStoreFile
		words = append([]string{":store", "load"}, words[3:]...)
	default:
		return input{first: first}, true
	}
	if read == nil {
		return input{}, false
	}
	text, err := read(path)
	if err != nil {
		return input{}, false
	}
	more := []any{}
	for _, l := range strings.Split(strings.TrimSuffix(text, "\n"), "\n") {
		more = append(more, strings.TrimSuffix(l, "\r"))
	}
	return input{first: strings.Join(words, " "), more: more}, true
}

// write answers a `write` need: `:store save` writes through
// WriteStoreFile, and `:export` through WriteFile.
func (h *Host) write(directory, name, data string) bool {
	if strings.HasPrefix(h.command, ":store") {
		if h.env.WriteStoreFile == nil {
			return false
		}
		return h.env.WriteStoreFile(filepath.Join(directory, name), data) == nil
	}
	if h.env.WriteFile == nil {
		return false
	}
	return h.env.WriteFile(directory, name, data) == nil
}

// ------------------------------------------------------------ frames

type guestError struct {
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
}

type reply struct {
	Ref        int64           `json:"ref"`
	OK         json.RawMessage `json:"ok"`
	Need       json.RawMessage `json:"need"`
	Err        *guestError     `json:"err"`
	Output     []string        `json:"output"`
	Trace      []string        `json:"trace"`
	Transcript []string        `json:"transcript"`
}

func (h *Host) exchange(method string, fields map[string]any, ref int64) reply {
	data, err := h.guest.Exchange(method, fields, ref)
	if err != nil {
		panic(err)
	}
	var r reply
	if err := json.Unmarshal(data, &r); err != nil {
		panic(fmt.Errorf("session-v1 reply: %w", err))
	}
	if r.Err != nil {
		panic(fmt.Errorf("session-v1 %s: %s: %s", method, r.Err.Kind, r.Err.Detail))
	}
	return r
}

// query is a frame with no records: its `ok`.
func (h *Host) query(method string, fields map[string]any) json.RawMessage {
	return h.exchange(method, fields, 0).OK
}

// timed is a frame that runs the session, with the Clock reading it Pumps
// with under a real Clock.
func (h *Host) timed(method string, fields map[string]any) []string {
	if !h.virtual {
		fields["reading"] = instantText(h.env.Now())
	}
	return h.call(method, fields)
}

// call sends a frame that runs the session and answers each need it stops
// at, and returns what the session printed.
func (h *Host) call(method string, fields map[string]any) []string {
	r := h.exchange(method, fields, 0)
	var out []string
	for {
		out = append(out, h.records(r)...)
		if r.Need == nil {
			break
		}
		m, answer := h.answer(r.Need)
		r = h.exchange(m, answer, r.Ref)
	}
	h.settle(r.OK)
	return out
}

// records passes a reply's Trace and Transcript on, and returns its output.
func (h *Host) records(r reply) []string {
	if h.env.Trace != nil {
		for _, l := range r.Trace {
			h.env.Trace(l)
		}
	}
	items := parseLines(r.Transcript)
	if h.replay != nil {
		h.replay.written += len(r.Transcript)
	}
	for _, i := range items {
		if i.Kind == "envelope" {
			h.lastEnvelope = i.Text
		}
		if h.env.Record != nil {
			h.env.Record(i)
		}
	}
	return r.Output
}

// settle reads what the session waits for now.
func (h *Host) settle(ok json.RawMessage) {
	var state struct {
		Waiting  string  `json:"waiting"`
		Clock    string  `json:"clock"`
		Deadline *string `json:"deadline"`
	}
	if err := json.Unmarshal(ok, &state); err != nil {
		panic(err)
	}
	h.virtual = state.Clock == "virtual"
	h.deadline = time.Time{}
	if state.Deadline != nil {
		h.deadline = parseInstant(*state.Deadline)
	}
	h.waiting = Waiting{Kind: state.Waiting}
	switch state.Waiting {
	case "deadline":
		h.waiting.At = h.deadline
	case "user":
		var p struct {
			Call     string   `json:"call"`
			Kind     string   `json:"kind"`
			Message  string   `json:"message"`
			Prompt   string   `json:"prompt"`
			Default  string   `json:"default"`
			Items    []string `json:"items"`
			Multiple bool     `json:"multiple"`
		}
		if err := json.Unmarshal(h.query("session-describe-prompt", nil), &p); err != nil {
			panic(err)
		}
		h.waiting.Call = p.Call
		h.waiting.Prompt = &Prompt{Kind: p.Kind, Message: p.Message, Prompt: p.Prompt, Fallback: p.Default, Items: p.Items, Multiple: p.Multiple}
	}
}

// answer is the result for a need: from the recorded Transcript when one
// replays, or else from the Environment.
func (h *Host) answer(raw json.RawMessage) (string, map[string]any) {
	var need struct {
		M         string      `json:"m"`
		Directory string      `json:"directory"`
		Name      string      `json:"name"`
		Data      string      `json:"data"`
		Objects   [][2]string `json:"objects"`
	}
	if err := json.Unmarshal(raw, &need); err != nil {
		panic(err)
	}
	switch need.M {
	case "write":
		written := true
		if h.replay == nil {
			written = h.write(need.Directory, need.Name, need.Data)
		}
		return "write-result", map[string]any{"written": written}
	case "resolve":
		outcomes := make([]any, len(need.Objects))
		for i, o := range need.Objects {
			switch {
			case h.replay != nil:
				outcomes[i] = h.replay.resolved(o[0], o[1])
			case h.env.ResolveObject != nil:
				_, outcomes[i] = h.env.ResolveObject(o[0], o[1])
			case h.objects != nil:
				outcomes[i] = h.objects.declared(o[0], o[1])
			default:
				outcomes[i] = false
			}
		}
		return "resolve-result", map[string]any{"objects": outcomes}
	case "prop":
		if h.replay != nil && h.objects == nil {
			return "prop-result", h.replay.crossing(h.lastEnvelope)
		}
		if h.objects == nil {
			return "prop-result", map[string]any{"hostError": true}
		}
		return "prop-result", h.objects.cross(raw)
	}
	panic(fmt.Errorf("session-v1 asked for an unknown need %q", need.M))
}

// objectByID is a Host Object the session names: one Go declared, or else
// one the session made, which Go never calls.
func (h *Host) objectByID(kind, id string) (any, bool) {
	if h.objects == nil {
		h.objects = newObjects(h)
	}
	return h.objects.named(kind, id), true
}

// ------------------------------------------------------------ Transcript lines

// parseLines reads a reply's Transcript lines as Items, folding an input's
// `|` lines into it.
func parseLines(lines []string) []Item {
	var items []Item
	for _, line := range lines {
		rest := func(mark string) string {
			if line == mark {
				return ""
			}
			return strings.TrimPrefix(line, mark+" ")
		}
		switch {
		case line == "":
			items = append(items, Item{Kind: "output"})
		case line[0] == '>':
			items = append(items, Item{Kind: "input", Text: rest(">")})
		case line[0] == '|':
			last := &items[len(items)-1]
			last.Text += "\n" + rest("|")
		case line[0] == '<':
			items = append(items, Item{Kind: "read", Text: rest("<")})
		case line[0] == '@':
			items = append(items, Item{Kind: "clock", At: parseInstant(rest("@"))})
		case line[0] == '~':
			call, answer, _ := strings.Cut(rest("~"), " ")
			items = append(items, Item{Kind: "answer", Call: call, Text: answer})
		case line[0] == '%':
			items = append(items, Item{Kind: "envelope", Text: rest("%")})
		case line[0] == '\'':
			items = append(items, Item{Kind: "output", Text: line[1:]})
		default:
			items = append(items, Item{Kind: "output", Text: line})
		}
	}
	return items
}

func parseInstant(shown string) time.Time {
	x, err := v.ParseDisplay(shown, nil)
	if err != nil || x.Kind != v.Instant {
		panic(fmt.Errorf("session-v1 gave %q for an Instant", shown))
	}
	return x.Time()
}

func instantText(t time.Time) string {
	x, err := v.InstantFromTime(t)
	if err != nil {
		panic(err)
	}
	return x.Display()
}
