package main

// The Script Runner: `northtalk app.talk [args…]` (chapter 12, The Script
// Runner; ADR 0126). It loads the file as one Script, Delivers `start` and
// runs until nothing can happen again, as tooling/cli/src/run.ts does.

import (
	"bufio"
	"context"
	cryptorand "crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/driver"
	"github.com/odogono/odgn-talk/impl/go/httphost"
	"github.com/odogono/odgn-talk/impl/go/session"
	"github.com/odogono/odgn-talk/impl/go/store"
)

// drainTimeout is how long the first signal waits for open HTTP Exchanges.
const drainTimeout = 5 * time.Second

type runOptions struct {
	file string
	args []string // the arguments after the file, given to `start`
	port *int     // overrides every `serve`'s port; -port or PORT
}

// runIO is the Runner's outside world, injected so tests can drive it.
type runIO struct {
	stdin          io.Reader
	stdout, stderr io.Writer
	tty            bool // stdin is a terminal: `user` is granted
	signals        <-chan os.Signal
	exit           func(code int) // a second signal exits at once
}

// signalCode is the exit code a signal ends the Runner with.
func signalCode(s os.Signal) int {
	switch s {
	case os.Interrupt, syscall.SIGINT:
		return 130
	case syscall.SIGTERM:
		return 143
	}
	return 1
}

// lockedWriter serializes writes from the worker, timers and signals.
type lockedWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (l *lockedWriter) line(s string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, _ = io.WriteString(l.w, s+"\n")
}

// scriptName is the file's basename without its extension.
func scriptName(file string) string {
	base := filepath.Base(file)
	if name := strings.TrimSuffix(base, filepath.Ext(base)); name != "" {
		return name
	}
	return "main"
}

func textOf(v talk.Value) string {
	if s, ok := v.AsText(); ok {
		return s
	}
	return v.String()
}

func mustText(s string) talk.Value { v, _ := talk.Text(s); return v }

// runScript runs the file and returns the exit code.
func runScript(o runOptions, rio runIO) int {
	stdout := &lockedWriter{w: rio.stdout}
	stderr := &lockedWriter{w: rio.stderr}
	b, err := os.ReadFile(o.file)
	if err != nil {
		stderr.line(err.Error())
		return 2
	}
	name := scriptName(o.file)
	core := talk.New()
	var failed, stopping atomic.Bool
	check := make(chan struct{}, 1)
	poke := func() {
		select {
		case check <- struct{}{}:
		default:
		}
	}
	h, err := httphost.New(core, httphost.Options{PortOverride: o.port, Log: stderr.line})
	if err != nil {
		stderr.line(err.Error())
		return 1
	}
	stores := store.New(store.SessionQuotas())
	pool := driver.NewPool(driver.PoolOptions{Workers: 1, OnPump: func(m *driver.Member, r talk.PumpResult, err error) {
		if err != nil {
			stderr.line(err.Error())
			failed.Store(true)
			poke()
			return
		}
		h.Pumped(m.Group(), r)
		stores.Router.Pumped(m.Group())
		for _, report := range r.Reports {
			if reportProblem(stderr, report, o.file, name) {
				failed.Store(true)
			}
		}
		if r.State == talk.Idle && r.NextDeadline.IsZero() {
			poke()
		}
	}})
	var seed [8]byte
	_, _ = cryptorand.Read(seed[:])
	member := pool.NewGroup(core, talk.GroupOptions{Name: "main", Seed: binary.LittleEndian.Uint64(seed[:])})
	timers := newTimers()
	lines := &lineReader{in: rio.stdin}

	grants := map[string]*talk.Grant{}
	grant := func(capability string, def *talk.CapabilityDef, err error, binding any) {
		if err != nil {
			panic(err) // the Standard Capabilities are fixed: a mistake here is the Runner's
		}
		grants[capability] = def.GrantAll(binding)
	}
	def, err := core.ConsoleCapability(console{stdout, lines}, talk.Costs{"write": {}, "read": {}})
	grant("console", def, err, nil)
	def, err = core.ClockCapability(talk.Costs{"now": {}})
	grant("clock", def, err, nil)
	def, err = core.TimerCapability(timers, talk.Costs{"schedule": {}, "cancel": {}})
	grant("timer", def, err, nil)
	def, err = core.CalendarCapability(calendar{}, talk.Costs{"today": {}, "now": {}, "toCivil": {}, "toInstant": {}, "offset": {}, "zone": {}})
	grant("calendar", def, err, "UTC")
	def, err = core.LocaleCapability(locale{}, talk.Costs{"compare": {}, "rank": {}, "upper": {}, "lower": {}, "numberSymbols": {}, "monthNames": {}, "dayNames": {}, "tag": {}})
	grant("locale", def, err, "und")
	def, err = core.StoreCapability(stores, talk.Costs{"watch": {}, "unwatch": {}, "get": {}, "keys": {}, "set": {}, "delete": {}, "increment": {}, "swap": {}})
	grant("store", def, err, "default")
	def, err = core.HTTPCapability(h, talk.Costs{"serve": {}, "unserve": {}, "respond": {}})
	grant("http", def, err, nil)
	databases := newLazySqlite()
	def, err = core.SqliteCapability(databases, talk.Costs{"query": {}, "change": {}, "begin": {}, "commit": {}, "rollback": {}}, 0)
	grant("sqlite", def, err, talk.SqliteBinding{Database: "main", MaxRows: maxRows})
	if rio.tty {
		def, err = core.UserCapability(&terminalUser{out: stdout, lines: lines}, talk.Costs{"confirm": {}, "choose": {}, "enter": {}, "notify": {}})
		grant("user", def, err, nil)
	}

	var script *talk.Script
	err = member.Do(func(g *talk.Group) error {
		script, err = g.Load(talk.LoadOptions{Name: name, Source: string(b), Grants: grants, GrantsAsUsed: true})
		return err
	})
	if err != nil {
		var le *talk.LoadError
		if !errors.As(err, &le) {
			stderr.line(err.Error())
		} else {
			for _, d := range le.Diagnostics {
				// A diagnostic's message may already begin with its code.
				message := d.Message
				if !strings.HasPrefix(message, d.Code) {
					message = d.Code + ": " + message
				}
				stderr.line(fmt.Sprintf("%s:%d:%d: %s", o.file, d.Line, d.Col, message))
			}
		}
		pool.Close()
		_ = h.Close()
		_ = databases.close()
		return 1
	}

	// Stops everything the Runner started.
	shutDown := func(code int) int {
		timers.stop()
		pool.Close()
		if err := h.Close(); err != nil {
			stderr.line(err.Error())
		}
		if err := databases.close(); err != nil {
			stderr.line(err.Error())
		}
		return code
	}
	// Nothing can happen again: no live Runs or queued messages, no timers,
	// Serve Registrations or open HTTP Exchanges. A pending `console.read` or
	// `user` prompt keeps its Run alive.
	done := func() bool {
		if stopping.Load() || timers.live() || h.Registrations() > 0 || h.OpenExchanges() > 0 {
			return false
		}
		busy := false
		_ = member.Do(func(g *talk.Group) error {
			for _, s := range g.Inspect().Scripts {
				busy = busy || len(s.Runs) > 0 || len(s.Mailbox) > 0
			}
			return nil
		})
		return !busy
	}

	stopped := make(chan int, 1)
	go func() {
		signalled := -1
		for s := range rio.signals {
			code := signalCode(s)
			if signalled >= 0 {
				rio.exit(signalled)
				return
			}
			signalled = code
			stopping.Store(true)
			h.StopAccepting()
			// A Script without a `stop` Handler ends that Run `unhandled`.
			_, _ = script.Deliver(talk.Message{Name: "stop"})
			go func() {
				// Let the `stop` Run go as far as it can before the Group stops.
				pool.Wait()
				h.Drain(drainTimeout)
				stopped <- code
			}()
		}
	}()

	args := make([]talk.Value, len(o.args))
	for i, a := range o.args {
		args[i] = mustText(a)
	}
	if _, err := script.Deliver(talk.Message{Name: "start", Args: []talk.Value{talk.List(args...)}}); err != nil {
		stderr.line(err.Error())
		return shutDown(1)
	}
	for {
		select {
		case code := <-stopped:
			return shutDown(code)
		case <-check:
			if done() {
				code := 0
				if failed.Load() {
					code = 1
				}
				return shutDown(code)
			}
		}
	}
}

// reportProblem writes a Run that ended with an uncaught error, or a Host
// mistake, to standard error. True when the exit code is to be 1.
func reportProblem(w *lockedWriter, report talk.Report, file, name string) bool {
	where := func(at talk.Location) string {
		if at.Unit == name && at.Line > 0 {
			return fmt.Sprintf("%s:%d:%d: ", file, at.Line, at.Col)
		}
		return file + ": "
	}
	switch r := report.(type) {
	case *talk.RunEnd:
		handler := ""
		if r.Handler != "" {
			handler = " in " + r.Handler
		}
		switch {
		case r.Outcome == talk.Errored && r.Error != nil:
			message := ""
			if r.Error.Message != "" {
				message = ": " + r.Error.Message
			}
			fields := ""
			if r.Error.Data.Kind() == talk.KindMap {
				var kept []talk.Pair
				for _, p := range r.Error.Data.Entries() {
					if p.Key != "at" {
						kept = append(kept, p)
					}
				}
				if len(kept) > 0 {
					if m, err := talk.Map(kept...); err == nil {
						fields = " " + m.String()
					}
				}
			}
			w.line(where(r.At) + "uncaught error" + handler + ": " + r.Error.Code + message + fields)
			return true
		case r.Outcome == talk.LimitFault || r.Outcome == talk.EffectFailureOutcome:
			outcome := "limit fault"
			if r.Outcome == talk.EffectFailureOutcome {
				outcome = "effect failed"
			}
			limit := ""
			if r.Limit != "" {
				limit = " (" + r.Limit + ")"
			}
			w.line(where(r.At) + outcome + handler + limit)
			return true
		}
	case *talk.HostError:
		w.line(file + ": host error: " + r.Detail)
		return true
	case *talk.CallFailed:
		w.line(file + ": call failed: " + r.Detail)
		return true
	}
	return false
}

// timers keeps each Script's timers by name, and Delivers due messages.
type timers struct {
	mu       sync.Mutex
	pending  map[string]*time.Timer
	firing   int // timers that left pending and are Delivering
	disarmed bool
}

func newTimers() *timers { return &timers{pending: map[string]*time.Timer{}} }

func (t *timers) Schedule(c *talk.Call, name string, at talk.Value, message string, args talk.Value) error {
	key := c.ScriptName() + "\x00" + name
	seconds, micros, _ := at.AsInstant()
	d := time.Until(time.Unix(seconds, int64(micros)*1000))
	values := make([]talk.Value, args.Len())
	for i := range values {
		values[i] = args.Index(i + 1)
	}
	script := c.Group().Script(c.ScriptName())
	t.mu.Lock()
	defer t.mu.Unlock()
	if old := t.pending[key]; old != nil {
		old.Stop()
	}
	if t.disarmed {
		return nil
	}
	var timer *time.Timer
	timer = time.AfterFunc(max(d, 0), func() {
		t.mu.Lock()
		if t.pending[key] != timer {
			t.mu.Unlock()
			return
		}
		delete(t.pending, key)
		t.firing++
		t.mu.Unlock()
		if script != nil {
			_, _ = script.Deliver(talk.Message{Name: message, Args: values})
		}
		t.mu.Lock()
		t.firing--
		t.mu.Unlock()
	})
	t.pending[key] = timer
	return nil
}

func (t *timers) Cancel(c *talk.Call, name string) error {
	key := c.ScriptName() + "\x00" + name
	t.mu.Lock()
	defer t.mu.Unlock()
	if old := t.pending[key]; old != nil {
		old.Stop()
		delete(t.pending, key)
	}
	return nil
}

func (t *timers) live() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.pending) > 0 || t.firing > 0
}

func (t *timers) stop() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.disarmed = true
	for key, timer := range t.pending {
		timer.Stop()
		delete(t.pending, key)
	}
}

// console writes lines to standard output and reads them from standard input.
type console struct {
	out   *lockedWriter
	lines *lineReader
}

func (c console) Write(_ *talk.Call, v talk.Value) error { c.out.line(textOf(v)); return nil }
func (c console) Read(call *talk.Call) error {
	c.lines.wait(call, func(line string) { call.Answer(mustText(line)) })
	return nil
}

// cancelRun cancels the Run a call belongs to.
func cancelRun(c *talk.Call) {
	if s := c.Group().Script(c.ScriptName()); s != nil {
		s.CancelRun(c.RunID())
	}
}

type lineWaiter struct {
	call *talk.Call
	take func(string)
}

// lineReader gives standard input's lines to waiting `console.read` and `user`
// calls. It starts reading at the first wait, so a Script that reads nothing
// never touches standard input. At its end, each waiting Run is cancelled.
type lineReader struct {
	in       io.Reader
	mu       sync.Mutex
	started  bool
	ended    bool
	buffered []string
	waiting  []*lineWaiter
}

func (r *lineReader) wait(c *talk.Call, take func(string)) {
	r.mu.Lock()
	if len(r.buffered) > 0 {
		line := r.buffered[0]
		r.buffered = r.buffered[1:]
		r.mu.Unlock()
		take(line)
		return
	}
	if r.ended {
		r.mu.Unlock()
		// Cancelled once the call is pending, after its start returns.
		go cancelRun(c)
		return
	}
	w := &lineWaiter{call: c, take: take}
	r.waiting = append(r.waiting, w)
	if !r.started {
		r.started = true
		go r.read()
	}
	r.mu.Unlock()
	if ctx := c.Context(); ctx != nil {
		context.AfterFunc(ctx, func() {
			r.mu.Lock()
			defer r.mu.Unlock()
			for i, x := range r.waiting {
				if x == w {
					r.waiting = append(r.waiting[:i], r.waiting[i+1:]...)
					break
				}
			}
		})
	}
}

func (r *lineReader) read() {
	scanner := bufio.NewScanner(r.in)
	scanner.Buffer(make([]byte, 64*1024), 16<<20)
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		r.mu.Lock()
		if len(r.waiting) > 0 {
			w := r.waiting[0]
			r.waiting = r.waiting[1:]
			r.mu.Unlock()
			w.take(line)
			continue
		}
		r.buffered = append(r.buffered, line)
		r.mu.Unlock()
	}
	r.mu.Lock()
	r.ended = true
	waiting := r.waiting
	r.waiting = nil
	r.mu.Unlock()
	for _, w := range waiting {
		cancelRun(w.call)
	}
}

// terminalUser is `user` at a terminal, with the REPL's questions and answers.
type terminalUser struct {
	out    *lockedWriter
	lines  *lineReader
	mu     sync.Mutex
	asking bool
}

func (u *terminalUser) ask(c *talk.Call, p session.Prompt) error {
	u.mu.Lock()
	if u.asking {
		u.mu.Unlock()
		return &talk.ScriptError{Code: "user busy", Message: "Another prompt is waiting for an answer"}
	}
	u.asking = true
	u.mu.Unlock()
	release := func() { u.mu.Lock(); u.asking = false; u.mu.Unlock() }
	if ctx := c.Context(); ctx != nil {
		context.AfterFunc(ctx, release)
	}
	show := func() { u.out.line(strings.Join(driver.PromptLines(p), "\n")) }
	var take func(string)
	take = func(line string) {
		answer, ok := driver.PromptAnswer(p, line)
		if !ok {
			show()
			u.lines.wait(c, take)
			return
		}
		release()
		c.Answer(answer)
	}
	show()
	u.lines.wait(c, take)
	return nil
}

func (u *terminalUser) Confirm(c *talk.Call, message string) error {
	return u.ask(c, session.Prompt{Kind: "confirm", Message: message})
}
func (u *terminalUser) Choose(c *talk.Call, items []string, prompt string, multiple bool) error {
	return u.ask(c, session.Prompt{Kind: "choose", Items: items, Prompt: prompt, Multiple: multiple})
}
func (u *terminalUser) Enter(c *talk.Call, message, fallback string) error {
	return u.ask(c, session.Prompt{Kind: "enter", Message: message, Fallback: fallback})
}
func (u *terminalUser) Notify(_ *talk.Call, message, title string) error {
	if title != "" {
		title += ": "
	}
	u.out.line("* " + title + message)
	return nil
}
