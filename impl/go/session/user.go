package session

import (
	"strings"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// Prompt is a user prompt as the person sees it (chapter 12, Prompts). Kind is
// confirm, choose or enter; an omitted prompt, default or title is "".
type Prompt struct {
	Kind, Message, Prompt, Fallback string
	Items                           []string
	Multiple                        bool
}

type prompt struct {
	call   *talk.Call
	prompt Prompt
}

const userBusyMessage = "Another prompt is waiting for an answer"

// userBinding is the Session Host's user: one prompt at a time, shown by
// whoever drives the session, and notify printed at its call record.
type userBinding struct{ h *Host }

func (b userBinding) ask(c *talk.Call, p Prompt) error {
	h := b.h
	h.prunePrompts()
	if len(h.prompts) > 0 {
		h.record(Item{Kind: "answer", Call: string(c.ID()), Text: `fail {code: "user busy", message: "` + userBusyMessage + `"}`})
		return &talk.ScriptError{Code: "user busy", Message: userBusyMessage}
	}
	h.prompts[string(c.ID())] = &prompt{call: c, prompt: p}
	return nil
}
func (b userBinding) Confirm(c *talk.Call, message string) error {
	return b.ask(c, Prompt{Kind: "confirm", Message: message})
}
func (b userBinding) Choose(c *talk.Call, items []string, title string, multiple bool) error {
	return b.ask(c, Prompt{Kind: "choose", Items: items, Prompt: title, Multiple: multiple})
}
func (b userBinding) Enter(c *talk.Call, message, fallback string) error {
	return b.ask(c, Prompt{Kind: "enter", Message: message, Fallback: fallback})
}
func (b userBinding) Notify(c *talk.Call, message, title string) error {
	note := "* "
	if title != "" {
		note += title + ": "
	}
	b.h.notes[string(c.ID())] = note + message
	return nil
}

// AnswerPrompt answers the Foreground Run's user prompt with what the person
// gave: a boolean, the chosen item or items, the entered text, or Nothing.
func (h *Host) AnswerPrompt(answer talk.Value) []string {
	for id, p := range h.prompts {
		if h.foreground.run == "" || callRun(id) != h.foreground.run || p.call.Context().Err() != nil {
			continue
		}
		delete(h.prompts, id)
		h.record(Item{Kind: "answer", Call: id, Text: answer.String()})
		p.call.Answer(answer)
		return h.printed(h.pump())
	}
	return nil
}

// ReplayAnswer gives a Transcript's `~` line to the Session Host: a prompt's
// answer answers it, and a `user busy` the Host recorded itself is skipped.
func (h *Host) ReplayAnswer(item Item) (bool, []string) {
	if h.waiting.Kind == "user" && h.waiting.Call == item.Call {
		v, err := readDisplay(item.Text)
		if err != nil {
			return true, []string{"! bad arguments"}
		}
		return true, h.AnswerPrompt(v)
	}
	return strings.HasPrefix(item.Text, `fail {code: "user busy"`), nil
}

func (h *Host) prunePrompts() {
	for id, p := range h.prompts {
		if p.call.Context().Err() != nil {
			delete(h.prompts, id)
		}
	}
}

// promptOf rebuilds a restored prompt from its call's Operation and arguments.
func promptOf(operation string, args []talk.Value) Prompt {
	option := func(key string) talk.Value {
		if len(args) < 2 {
			return talk.Nothing
		}
		return args[1].Get(key)
	}
	text := func(v talk.Value) string { s, _ := v.AsText(); return s }
	switch operation {
	case "confirm":
		return Prompt{Kind: "confirm", Message: text(args[0])}
	case "enter":
		return Prompt{Kind: "enter", Message: text(args[0]), Fallback: text(option("default"))}
	}
	items := make([]string, args[0].Len())
	for i := range items {
		items[i] = text(args[0].Index(i + 1))
	}
	multiple, _ := option("multiple").AsBool()
	return Prompt{Kind: "choose", Items: items, Prompt: text(option("prompt")), Multiple: multiple}
}

// userDecls are the user Operations a Library is compiled against.
func userDecls() map[string]talk.OperationCheck {
	optionalText := talk.Optional(talk.TextShape)
	options := func(fields ...talk.Field) talk.Shape { return talk.Optional(talk.MapShape(fields...)) }
	return map[string]talk.OperationCheck{
		"confirm": {Mode: talk.Suspending, Args: []talk.Shape{talk.TextShape}},
		"choose": {Mode: talk.Suspending, Args: []talk.Shape{talk.ListOf(talk.TextShape), options(
			talk.Field{Key: "prompt", Shape: optionalText, Optional: true},
			talk.Field{Key: "multiple", Shape: talk.Optional(talk.BoolShape), Optional: true},
		)}},
		"enter":  {Mode: talk.Suspending, Args: []talk.Shape{talk.TextShape, options(talk.Field{Key: "default", Shape: optionalText, Optional: true})}},
		"notify": {Mode: talk.FireAndForget, Args: []talk.Shape{talk.TextShape, options(talk.Field{Key: "title", Shape: optionalText, Optional: true})}},
	}
}
