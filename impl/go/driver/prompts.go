package driver

// How the Go REPL shows a user prompt and reads its answer from a typed line.
// Both are outside parity (chapter 12, Prompts), and follow the TS REPL: the
// Transcript records only the answer.

import (
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/session"
)

var yes = regexp.MustCompile(`(?i)^y(es)?$`)
var picks = regexp.MustCompile(`[\s,]+`)

// promptLines are the lines that ask the question.
func promptLines(p session.Prompt) []string {
	switch p.Kind {
	case "confirm":
		return []string{"? " + p.Message + " [y/N]"}
	case "enter":
		if p.Fallback != "" {
			return []string{"? " + p.Message + " [" + p.Fallback + "]", "  an empty line gives the default"}
		}
		return []string{"? " + p.Message, "  an empty line cancels"}
	}
	title := p.Prompt
	if title == "" {
		title = "Choose one"
		if p.Multiple {
			title = "Choose any"
		}
	}
	out := []string{"? " + title}
	for i, item := range p.Items {
		out = append(out, fmt.Sprintf("  %d. %s", i+1, item))
	}
	if p.Multiple {
		return append(out, `  numbers separated by commas, "none" for none, or an empty line to cancel`)
	}
	return append(out, "  a number, or an empty line to cancel")
}

// promptAnswer is the answer a typed line gives, or false when it answers
// nothing and the question is asked again.
func promptAnswer(p session.Prompt, line string) (talk.Value, bool) {
	typed := strings.TrimSpace(line)
	text := func(s string) talk.Value { v, _ := talk.Text(s); return v }
	switch p.Kind {
	case "confirm":
		return talk.Bool(yes.MatchString(typed)), true
	case "enter":
		if line != "" {
			return text(line), true
		}
		if p.Fallback != "" {
			return text(p.Fallback), true
		}
		return talk.Nothing, true
	}
	if typed == "" {
		return talk.Nothing, true
	}
	if p.Multiple && strings.EqualFold(typed, "none") {
		return talk.List(), true
	}
	var chosen []int
	for _, word := range picks.Split(typed, -1) {
		n, err := strconv.Atoi(word)
		if err != nil || n < 1 || n > len(p.Items) {
			return talk.Nothing, false
		}
		if !slices.Contains(chosen, n) {
			chosen = append(chosen, n)
		}
	}
	if !p.Multiple {
		if len(chosen) != 1 || len(picks.Split(typed, -1)) != 1 {
			return talk.Nothing, false
		}
		return text(p.Items[chosen[0]-1]), true
	}
	slices.Sort(chosen)
	items := make([]talk.Value, len(chosen))
	for i, n := range chosen {
		items[i] = text(p.Items[n-1])
	}
	return talk.List(items...), true
}
