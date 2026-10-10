package main

import (
	"fmt"
	"slices"
	"strings"
	"sync"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// recorder is a tenant's Trace sink. A live Host has no Stubs, so it also
// notes what each Host function did, and writes those notes as `stub` lines
// ahead of the Pump that made the calls. The Trace then replays on a corpus
// runner without this Host (spec chapter 11, Stubs).
type recorder struct {
	mu     sync.Mutex
	lines  []string
	pumpAt int
	stubs  []string
}

func (r *recorder) Record(line string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if strings.HasPrefix(line, "> pump ") {
		r.pumpAt = len(r.lines)
	}
	r.lines = append(r.lines, line)
}

// stub is called from a Host function, inside the Pump.
func (r *recorder) stub(op string, v talk.Value, failure *talk.ScriptError, charge int64) {
	line := "> stub " + op
	switch {
	case failure != nil:
		pairs := []talk.Pair{talk.KV("code", mustText(failure.Code))}
		if failure.Message != "" {
			pairs = append(pairs, talk.KV("message", mustText(failure.Message)))
		}
		pairs = append(pairs, failure.Data.Entries()...)
		line += " error=" + mustMap(pairs...).String()
	case v.Kind() != talk.KindNothing:
		line += " value=" + v.String()
	}
	if charge != 0 {
		line += fmt.Sprintf(" charge=%d", charge)
	}
	r.mu.Lock()
	r.stubs = append(r.stubs, line)
	r.mu.Unlock()
}

// queued are the Host Inputs a Pump drains. The Core writes them as it
// drains them, so a replaying runner's Stub lines, which it writes as it
// reads them, come before them.
var queued = map[string]bool{"deliver": true, "request": true, "broadcast": true, "decide": true, "decide-broadcast": true, "call-value": true, "set-parent": true, "dispose": true, "stop": true, "cancel-run": true, "rewind-run": true, "cancel-delivery": true, "revoke": true, "answer": true, "fail": true, "settle": true}

// pumped puts the Pump's Stubs before the inputs it drained.
func (r *recorder) pumped() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.stubs) == 0 {
		return
	}
	at := r.pumpAt
	for at > 0 {
		kind, _, _ := strings.Cut(strings.TrimPrefix(r.lines[at-1], "> "), " ")
		if !strings.HasPrefix(r.lines[at-1], "> ") || !queued[kind] {
			break
		}
		at--
	}
	r.lines = slices.Insert(r.lines, at, r.stubs...)
	r.stubs = nil
}

func (r *recorder) trace() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.lines)
}

// comment adds `#` lines, wrapped, before the next inputs.
func (r *recorder) comment(text string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.lines) > 0 {
		r.lines = append(r.lines, "")
	}
	line := "#"
	for _, word := range strings.Fields(text) {
		if len(line)+1+len(word) > 76 {
			r.lines = append(r.lines, line)
			line = "#"
		}
		line += " " + word
	}
	r.lines = append(r.lines, line)
}
