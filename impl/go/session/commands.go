package session

import (
	"fmt"
	"math/big"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

var nameText = regexp.MustCompile(`^[\pL_][\pL\pN_]*$`)
var digits = regexp.MustCompile(`^\d+$`)

func split(s string) (string, string) {
	s = strings.TrimSpace(s)
	i := strings.IndexAny(s, " \t\n\r")
	if i < 0 {
		return s, ""
	}
	return s[:i], strings.TrimSpace(s[i:])
}
func refusal(reason string) []string { return []string{"! " + reason} }
func readDisplay(s string) (talk.Value, error) {
	v, err := value.ParseDisplay(s, nil)
	if err != nil {
		return talk.Nothing, err
	}
	b, err := value.Encode(v, false)
	if err != nil {
		return talk.Nothing, err
	}
	return talk.DecodeValue(b, nil)
}
func errorMap(s string) (*talk.ScriptError, error) {
	v, err := readDisplay(s)
	if err != nil || v.Kind() != talk.KindMap {
		return nil, fmt.Errorf("bad arguments")
	}
	code, ok := v.Get("code").AsText()
	if !ok {
		return nil, fmt.Errorf("bad arguments")
	}
	message, _ := v.Get("message").AsText()
	var fields []talk.Pair
	for _, p := range v.Entries() {
		if p.Key != "code" && p.Key != "message" {
			fields = append(fields, p)
		}
	}
	data, _ := talk.Map(fields...)
	return &talk.ScriptError{Code: code, Message: message, Data: data}, nil
}
func (h *Host) command(source string) []string {
	command := strings.TrimPrefix(source, ":")
	name, rest := command, ""
	if i := strings.IndexAny(command, " \t\n\r"); i >= 0 {
		name, rest = command[:i], strings.TrimLeft(command[i:], " \t\n\r")
	}
	words := strings.Fields(rest)
	if name == "grant" || name == "mock" {
		if h.Started() {
			return refusal("session started")
		}
		if name == "grant" {
			if len(words) < 2 || len(words) > 3 || !nameText.MatchString(words[0]) || words[0] == "console" {
				return refusal("bad arguments")
			}
			if len(words) == 3 && words[1] != "store" {
				return refusal("bad arguments")
			}
			found := words[1] == "clock" || words[1] == "store"
			for _, m := range h.mocks {
				found = found || m.capability == words[1]
			}
			if !found {
				return refusal("bad arguments")
			}
			h.granted[words[0]] = words[1]
			delete(h.bindings, words[0])
			if words[1] == "store" {
				binding := "default"
				if len(words) == 3 {
					binding = words[2]
				}
				h.bindings[words[0]] = binding
			}
			return nil
		}
		if len(words) != 2 {
			return refusal("bad arguments")
		}
		cap, op, ok := strings.Cut(words[0], ".")
		mode := talk.Mode(-1)
		switch words[1] {
		case "immediate":
			mode = talk.Immediate
		case "suspending":
			mode = talk.Suspending
		case "fire-and-forget":
			mode = talk.FireAndForget
		}
		if slices.Contains([]string{"ask", "tell", "send", "wait"}, op) || !ok || !nameText.MatchString(cap) || !nameText.MatchString(op) || mode < 0 || cap == "console" || cap == "clock" || cap == "calendar" || cap == "locale" || cap == "store" {
			return refusal("bad arguments")
		}
		m := mock{cap, op, mode}
		replaced := false
		for i, old := range h.mocks {
			if old.capability == cap && old.operation == op {
				h.mocks[i] = m
				replaced = true
			}
		}
		if !replaced {
			h.mocks = append(h.mocks, m)
		}
		h.granted[cap] = cap
		return nil
	}
	switch name {
	case "stub", "answer", "fail", "clock", "limits", "cancel", "save", "restore", "library", "export", "store":
		h.start()
	case "runs", "mailbox", "vars":
		if len(words) > 0 {
			return refusal("bad arguments")
		}
		h.start()
	case "help":
		h.recording = nil
		return []string{"Commands: :grant :mock :stub :answer :fail :clock :limits :cancel :runs :mailbox :vars :save :restore :library :export :store :help :quit"}
	case "quit":
		h.recording = nil
		return nil
	default:
		return refusal("unknown command")
	}
	switch name {
	case "stub":
		target, after := split(rest)
		found := false
		for _, m := range h.mocks {
			if m.capability+"."+m.operation == target && m.mode == talk.Immediate {
				found = true
			}
		}
		if !found {
			return refusal("bad arguments")
		}
		first, remainder := split(after)
		var s stub
		var err error
		if first == "fail" {
			s.failure, err = errorMap(remainder)
		} else {
			s.value, err = readDisplay(after)
		}
		if err != nil {
			return refusal("bad arguments")
		}
		h.stubs[target] = append(h.stubs[target], s)
		line := "> stub " + target
		if s.failure != nil {
			v, _ := value.ParseDisplay(remainder, nil)
			line += " error=" + v.Display()
		} else {
			line += " value=" + s.value.String()
		}
		if h.env.Trace != nil {
			h.env.Trace(line)
		}
		return nil
	case "answer", "fail":
		id, source := split(rest)
		var v talk.Value
		var failure *talk.ScriptError
		var err error
		if name == "answer" {
			v, err = readDisplay(source)
		} else {
			failure, err = errorMap(source)
		}
		if err != nil {
			return refusal("bad arguments")
		}
		c := h.pending[id]
		if c == nil || c.Context().Err() != nil {
			return refusal("no such call")
		}
		delete(h.pending, id)
		if name == "answer" {
			c.Answer(v)
		} else {
			c.Fail(failure)
		}
		return h.pump()
	case "clock":
		return h.clock(rest)
	case "limits":
		return h.limit(words)
	case "cancel":
		if len(words) > 1 {
			return refusal("bad arguments")
		}
		run := h.latest.run
		if len(words) == 1 {
			run = words[0]
		}
		if _, ok := h.segments[run]; !ok || run == "" {
			return refusal("no such run")
		}
		h.script.CancelRun(talk.RunID(run))
		return h.pump()
	case "save", "restore":
		if len(words) > 1 {
			return refusal("bad arguments")
		}
		key := "default"
		if len(words) == 1 {
			key = words[0]
		}
		if name == "save" {
			return h.save(key)
		}
		return h.restore(key)
	case "store":
		return h.store(rest)
	case "library":
		return h.library(rest)
	case "export":
		if len(words) > 1 {
			return refusal("bad arguments")
		}
		if len(words) == 0 {
			if h.Source() == "" {
				return nil
			}
			return strings.Split(strings.TrimSuffix(h.Source(), "\n"), "\n")
		}
		if h.env.WriteFile == nil {
			return refusal("bad arguments")
		}
		type file struct{ name, source string }
		files := []file{{"session.talk", h.Source()}}
		for _, name := range h.libraryOrder {
			files = append(files, file{name + ".talk", h.libraries[name].compiled.Source()})
		}
		var out []string
		for _, f := range files {
			if err := h.env.WriteFile(words[0], f.name, f.source); err != nil {
				return refusal("bad arguments")
			}
			out = append(out, "wrote "+f.name)
		}
		return out
	case "vars", "mailbox", "runs":
		return h.inspected(name)
	}
	return nil
}
func (h *Host) clock(rest string) []string {
	word, arg := split(rest)
	switch word {
	case "":
		if h.VirtualClock() {
			return []string{"virtual " + formatTime(h.virtual)}
		}
		if h.hasClock {
			return []string{"real " + formatTime(h.lastClock)}
		}
		return []string{"real"}
	case "real":
		if arg != "" {
			return refusal("bad arguments")
		}
		h.virtualOn = false
		return nil
	case "virtual":
		at := h.lastClock
		if !h.hasClock && arg == "" {
			at = h.env.Now()
		}
		if arg != "" {
			v, err := value.ParseDisplay(arg, nil)
			if err != nil || v.Kind != value.Instant {
				return refusal("bad arguments")
			}
			at = time.Unix(v.Seconds, int64(v.Nanos)).UTC()
		}
		if h.hasClock && at.Before(h.lastClock) {
			return refusal("clock backwards")
		}
		h.virtual = at
		h.virtualOn = true
		recorded := ":clock virtual " + formatTime(at)
		h.recording = &recorded
		return nil
	case "advance":
		if !h.VirtualClock() {
			return refusal("clock is real")
		}
		v, err := value.ParseDisplay(arg, nil)
		if err != nil || v.Kind != value.Quantity {
			return refusal("bad arguments")
		}
		seconds, _ := value.ParseUnit("s")
		if !v.Unit.Compatible(seconds) {
			return refusal("bad arguments")
		}
		n, err := v.Unit.Convert(v.Number, true)
		if err != nil {
			return refusal("bad arguments")
		}
		ns := new(big.Rat).Mul(n.Rat(), big.NewRat(1000000000, 1))
		if ns.Sign() < 0 {
			return refusal("bad arguments")
		}
		// Add seconds separately: time.Duration has a narrower range than Instants.
		q, r := new(big.Int), new(big.Int)
		nanos, fraction := new(big.Int), new(big.Int)
		nanos.QuoRem(ns.Num(), ns.Denom(), fraction)
		if cmp := new(big.Int).Lsh(fraction, 1).Cmp(ns.Denom()); cmp > 0 || cmp == 0 && nanos.Bit(0) != 0 {
			nanos.Add(nanos, big.NewInt(1))
		}
		q.QuoRem(nanos, big.NewInt(1000000000), r)
		if !q.IsInt64() {
			return refusal("bad arguments")
		}
		sec := new(big.Int).Add(big.NewInt(h.virtual.Unix()), q)
		if !sec.IsInt64() {
			return refusal("bad arguments")
		}
		at := time.Unix(sec.Int64(), int64(h.virtual.Nanosecond())+r.Int64()).UTC()
		if _, err := value.ParseDisplay(formatTime(at), nil); err != nil {
			return refusal("bad arguments")
		}
		h.virtual = at
		return h.pump()
	}
	return refusal("bad arguments")
}

var limitNames = []string{"fuelPerRun", "allocPerRun", "maxWaitMs", "maxJoin"}

func defaults() map[string]int64 {
	d := talk.DefaultLimits()
	return map[string]int64{"fuelPerRun": d.FuelPerRun, "allocPerRun": d.AllocPerRun, "maxWaitMs": int64(d.MaxWait / time.Millisecond), "maxJoin": int64(d.MaxJoin)}
}
func (h *Host) limit(words []string) []string {
	d := defaults()
	if len(words) == 0 {
		var out []string
		for _, name := range limitNames {
			v := d[name]
			if n, ok := h.limits[name]; ok {
				v = n
			}
			out = append(out, fmt.Sprintf("%s %d", name, v))
		}
		return out
	}
	if len(words) == 1 && words[0] == "reset" {
		h.limits = map[string]int64{}
		return nil
	}
	if len(words) != 2 {
		return refusal("bad arguments")
	}
	maxValue, ok := d[words[0]]
	if !ok || !digits.MatchString(words[1]) {
		return refusal("bad arguments")
	}
	n, err := strconv.ParseInt(words[1], 10, 64)
	if err != nil || n > maxValue {
		return refusal("invalid value")
	}
	h.limits[words[0]] = n
	return nil
}
func (h *Host) override() talk.LimitOverride {
	var set talk.LimitOverrideFields
	for i, name := range limitNames {
		if _, ok := h.limits[name]; ok {
			set |= 1 << i
		}
	}
	return talk.LimitOverride{Set: set, FuelPerRun: h.limits["fuelPerRun"], AllocPerRun: h.limits["allocPerRun"], MaxWait: time.Duration(h.limits["maxWaitMs"]) * time.Millisecond, MaxJoin: int(h.limits["maxJoin"])}
}
func (h *Host) inspected(what string) []string {
	var out []string
	s := h.group.Inspect().Scripts[0]
	switch what {
	case "vars":
		for _, p := range s.Vars {
			out = append(out, p.Key+" = "+p.Val.String())
		}
	case "mailbox":
		for _, m := range s.Mailbox {
			id := string(m.Delivery)
			if id == "" {
				id = m.From
			}
			out = append(out, id+" "+m.Message.Name+" "+talk.List(m.Message.Args...).String())
		}
	case "runs":
		for _, r := range s.Runs {
			status := []string{"ready", "suspended", "parked", "preempted"}[r.Status]
			line := string(r.ID) + " " + status + " " + r.Handler
			if r.Status == talk.Suspended {
				line += " " + r.Wait
				if !r.Until.IsZero() {
					line += " until " + formatTime(r.Until)
				}
				for _, c := range r.Calls {
					line += " " + string(c)
				}
			}
			out = append(out, line)
		}
	}
	return out
}
