// Package driver supplies deterministic transcript replay and the terminal
// driver around the ordinary Session Host. It is separate from the Core.
package driver

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/odogono/odgn-talk/impl/go/internal/value"
	"github.com/odogono/odgn-talk/impl/go/session"
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
			items = append(items, session.Item{Kind: "clock", At: time.Unix(v.Seconds, int64(v.Nanos)).UTC()})
		case '~':
			s, ok := rest("~")
			call, answer, hasAnswer := strings.Cut(s, " ")
			if !ok || !hasAnswer || call == "" || answer == "" {
				return fail("a call and answer after ~")
			}
			items = append(items, session.Item{Kind: "answer", Call: call, Text: answer})
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
		case "comment":
			b.WriteString(i.Text + "\n")
		case "output":
			if i.Text == "" || strings.ContainsRune(">|<@~#'", rune(i.Text[0])) {
				b.WriteByte('\'')
			}
			b.WriteString(i.Text + "\n")
		}
	}
	return b.String()
}
func formatInstant(t time.Time) string {
	v, _ := value.NewInstant(t.Unix(), int32(t.Nanosecond()))
	return v.Display()
}

// ReplayTranscript never writes files. A real Clock reading is offered to the
// input before it; an unused reading causes an independent deadline Pump.
// The returned Items include the actual outputs and recorder behavior.
func ReplayTranscript(recorded []session.Item, trace func(string)) (host *session.Host, items []session.Item, err error) {
	var offered *time.Time
	// Invalid replay input is a driver error, not a language diagnostic.
	defer func() {
		if p := recover(); p != nil {
			if e, ok := p.(replayError); ok {
				err = e
			} else {
				panic(p)
			}
		}
	}()
	host = session.New(session.Environment{
		Now: func() time.Time {
			if offered == nil {
				panic(replayError("Transcript has no @ reading for a Pump"))
			}
			at := *offered
			offered = nil
			return at
		},
		Record: func(i session.Item) { items = append(items, i) }, Trace: trace,
		WriteFile:      func(string, string, string) error { return nil },
		WriteStoreFile: func(string, string) error { return nil },
	})
	for n := 0; n < len(recorded); n++ {
		item := recorded[n]
		reading := func() {
			offered = nil
			if n+1 < len(recorded) && recorded[n+1].Kind == "clock" {
				n++
				at := recorded[n].At
				offered = &at
			}
		}
		switch item.Kind {
		case "input":
			reading()
			host.Input(item.Text)
			if offered != nil {
				host.Tick()
				offered = nil
			}
		case "read":
			reading()
			host.Read(item.Text)
			if offered != nil {
				host.Tick()
				offered = nil
			}
		case "clock":
			at := item.At
			offered = &at
			host.Tick()
			offered = nil
		case "comment":
			items = append(items, item)
		case "answer":
			return host, items, fmt.Errorf("built-in answers are not offered by this Go Session Host")
		}
	}
	return
}

type replayError string

func (e replayError) Error() string { return string(e) }
