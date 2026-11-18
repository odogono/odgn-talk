// Package driver supplies deterministic transcript replay and the terminal
// driver around the ordinary Session Host, and a Pool that pumps many Groups
// in parallel. It is separate from the Core.
package driver

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"northtalk.org/go/internal/value"
	"northtalk.org/go/session"
)

func ParseTranscript(source string) ([]session.Item, error) {
	if !utf8.ValidString(source) {
		return nil, fmt.Errorf("Transcript must be valid UTF-8")
	}
	if source != "" && !strings.HasSuffix(source, "\n") {
		return nil, fmt.Errorf("Transcript must end with LF")
	}
	if source == "" {
		return nil, nil
	}
	var items []session.Item
	for i, line := range strings.Split(strings.TrimSuffix(source, "\n"), "\n") {
		fail := func(reason string) ([]session.Item, error) {
			return nil, fmt.Errorf("Transcript line %d: %s", i+1, reason)
		}
		rest := func(mark string) (string, bool) {
			if line == mark {
				return "", true
			}
			return strings.CutPrefix(line, mark+" ")
		}
		if line == "" {
			return fail("an empty output line must be quoted")
		}
		switch line[0] {
		case '>':
			s, ok := rest(">")
			if !ok || s == "" {
				return fail("an Entry or Session Command after >")
			}
			items = append(items, session.Item{Kind: "input", Text: s})
		case '|':
			s, ok := rest("|")
			if !ok || len(items) == 0 || items[len(items)-1].Kind != "input" {
				return fail("a continuation must follow an input")
			}
			items[len(items)-1].Text += "\n" + s
		case '<':
			s, ok := rest("<")
			if !ok {
				return fail("a typed line after <")
			}
			items = append(items, session.Item{Kind: "read", Text: s})
		case '@':
			s, ok := rest("@")
			if !ok {
				return fail("an instant after @")
			}
			v, err := value.ParseDisplay(s, nil)
			if err != nil || v.Kind != value.Instant {
				return fail("an instant after @")
			}
			items = append(items, session.Item{Kind: "clock", At: v.Time()})
		case '~':
			s, ok := rest("~")
			call, answer, hasAnswer := strings.Cut(s, " ")
			if !ok || !hasAnswer || call == "" || answer == "" {
				return fail("a call and answer after ~")
			}
			items = append(items, session.Item{Kind: "answer", Call: call, Text: answer})
		case '%':
			source, ok := rest("%")
			if !ok || source == "" {
				return fail("an envelope after %")
			}
			if _, err := session.ParseEnvelope(source); err != nil {
				return fail(err.Error())
			}
			items = append(items, session.Item{Kind: "envelope", Text: source})
		case '#':
			items = append(items, session.Item{Kind: "comment", Text: line})
		case '\'':
			items = append(items, session.Item{Kind: "output", Text: line[1:]})
		default:
			items = append(items, session.Item{Kind: "output", Text: line})
		}
	}
	return items, nil
}
func WriteTranscript(items []session.Item) string {
	var b strings.Builder
	for _, i := range items {
		switch i.Kind {
		case "input":
			for n, line := range strings.Split(i.Text, "\n") {
				mark := "> "
				if n > 0 {
					mark = "| "
					if line == "" {
						mark = "|"
					}
				}
				b.WriteString(mark + line + "\n")
			}
		case "read":
			mark := "< "
			if i.Text == "" {
				mark = "<"
			}
			b.WriteString(mark + i.Text + "\n")
		case "clock":
			b.WriteString("@ " + formatInstant(i.At) + "\n")
		case "answer":
			b.WriteString("~ " + i.Call + " " + i.Text + "\n")
		case "envelope":
			b.WriteString("% " + i.Text + "\n")
		case "comment":
			b.WriteString(i.Text + "\n")
		case "output":
			if i.Text == "" || strings.ContainsRune(">|<@~%#'", rune(i.Text[0])) {
				b.WriteByte('\'')
			}
			b.WriteString(i.Text + "\n")
		}
	}
	return b.String()
}
func formatInstant(t time.Time) string {
	v, _ := value.InstantFromTime(t)
	return v.Display()
}

// ReplayTranscript replays a Transcript through a new session, as a Driver
// drives it: each input, typed line, answer, deadline and declaration it
// holds is one Host call, each crossing and Restore is answered from it, and
// it never writes files. Under a real Clock, each Host call reads the `@`
// line the session takes next, or else the last one. The returned Items are
// what the session recorded, with the Transcript's comments in place, for the
// caller to compare.
func ReplayTranscript(recorded []session.Item, trace func(string)) (host *session.Host, items []session.Item, err error) {
	// Invalid replay input is a driver error, not a language diagnostic.
	defer func() {
		if p := recover(); p != nil {
			if e, ok := p.(error); ok {
				err = e
			} else {
				panic(p)
			}
		}
	}()
	reading := time.Unix(0, 0).UTC()
	host = session.New(session.Environment{
		ObjectTranscript: recorded,
		Now:              func() time.Time { return reading },
		Record:           func(i session.Item) { items = append(items, i) },
		Trace:            trace,
		WriteFile:        func(string, string, string) error { return nil },
		WriteStoreFile:   func(string, string) error { return nil },
	})
	// Each item's first line; a comment is no line the session writes.
	starts := make([]int, len(recorded))
	at := 0
	for n, item := range recorded {
		starts[n] = at
		at += lineCount(item)
	}
	written := func() int {
		count := 0
		for _, item := range items {
			count += lineCount(item)
		}
		return count
	}
	n := 0
	for {
		// Past what the session has written so far.
		w := written()
		for n < len(recorded) && (starts[n] < w || recorded[n].Kind == "comment") {
			if recorded[n].Kind == "comment" && starts[n] >= w {
				items = append(items, recorded[n])
			}
			n++
		}
		// Output is the session's to write; a mismatch shows when compared.
		if n >= len(recorded) || starts[n] != w || recorded[n].Kind == "output" {
			break
		}
		item := recorded[n]
		// The reading the Host call takes: the `@` the session takes next.
		next := n + 1
		for next < len(recorded) && recorded[next].Kind == "output" {
			next++
		}
		if item.Kind == "clock" {
			reading = item.At
		} else if next < len(recorded) && recorded[next].Kind == "clock" {
			reading = recorded[next].At
		}
		switch item.Kind {
		case "input":
			host.Input(item.Text)
		case "read":
			host.Read(item.Text)
		case "clock":
			host.Tick()
		case "answer":
			if ok, _ := host.ReplayAnswer(item); !ok {
				return host, items, fmt.Errorf("Transcript line %d: an answer no prompt waits for", starts[n]+1)
			}
		case "envelope":
			e, err := session.ParseEnvelope(item.Text)
			if err != nil {
				return host, items, err
			}
			var typ string
			json.Unmarshal(e["type"], &typ)
			switch typ {
			case "kind", "object", "setup", "input":
				host.ReplayObjectItem(n)
			default:
				// Only the session makes the others.
				return host, items, nil
			}
		}
		if written() == w {
			return host, items, fmt.Errorf("Transcript line %d: the session didn't take it", starts[n]+1)
		}
	}
	host.FinishObjectReplay()
	// A replay that answers from the Transcript must make the same
	// envelopes; other lines are the caller's to compare.
	want, got := strings.Split(WriteTranscript(recorded), "\n"), strings.Split(WriteTranscript(items), "\n")
	for n := range min(len(want), len(got)) {
		if want[n] != got[n] {
			if strings.HasPrefix(want[n], "% ") || strings.HasPrefix(got[n], "% ") {
				return host, items, fmt.Errorf("Transcript line %d: expected %s, got %s", n+1, want[n], got[n])
			}
			break
		}
	}
	return
}

// lineCount is how many Transcript lines an item takes.
func lineCount(item session.Item) int {
	switch item.Kind {
	case "comment":
		return 0
	case "input":
		return 1 + strings.Count(item.Text, "\n")
	}
	return 1
}
