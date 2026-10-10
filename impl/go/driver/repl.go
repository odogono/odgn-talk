package driver

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/odogono/odgn-talk/impl/go/session"
)

// REPLOptions controls terminal-only presentation and I/O, outside parity.
// Input must be closed by its owner if a blocked reader needs to be released.
// Interrupt cancels a foreground Run or drops an unfinished Entry.
// Questions receives a user prompt's question, which isn't Session output;
// when nil, it is output with a Prompt, and stderr without.
type REPLOptions struct {
	Environment session.Environment
	Prompt      bool
	Interrupt   <-chan os.Signal
	Questions   io.Writer
}
type inputLine struct {
	text string
	err  error
	eof  bool
}

// RunREPL serializes all Host calls, leaving foreground deadline waits asleep
// while typed lines queue. Background deadlines continue at the prompt.
func RunREPL(ctx context.Context, input io.Reader, output io.Writer, options REPLOptions) error {
	host := session.New(options.Environment)
	lines := make(chan inputLine, 1)
	scanCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		scanner := bufio.NewScanner(input)
		scanner.Buffer(make([]byte, 4096), 16*1024*1024)
		for scanner.Scan() {
			select {
			case lines <- inputLine{text: scanner.Text()}:
			case <-scanCtx.Done():
				return
			}
		}
		select {
		case lines <- inputLine{err: scanner.Err(), eof: true}:
		case <-scanCtx.Done():
		}
	}()
	print := func(out []string) error {
		for _, line := range out {
			if _, err := fmt.Fprintln(output, line); err != nil {
				return err
			}
		}
		return nil
	}
	questions := options.Questions
	if questions == nil {
		questions = os.Stderr
		if options.Prompt {
			questions = output
		}
	}
	ask := func(p session.Prompt) error {
		for _, line := range promptLines(p) {
			if _, err := fmt.Fprintln(questions, line); err != nil {
				return err
			}
		}
		return nil
	}
	asked := ""
	var entry []string
	for {
		waiting := host.Waiting()
		if waiting.Kind == "user" && waiting.Call != asked {
			asked = waiting.Call
			if err := ask(*waiting.Prompt); err != nil {
				return err
			}
		}
		if options.Prompt && waiting.Kind != "deadline" {
			prompt := "> "
			if len(entry) > 0 {
				prompt = "| "
			}
			if waiting.Kind == "read" || waiting.Kind == "user" {
				prompt = ""
			}
			if _, err := io.WriteString(output, prompt); err != nil {
				return err
			}
		}
		var timer *time.Timer
		var due <-chan time.Time
		deadline := host.NextDeadline()
		if !host.VirtualClock() && !deadline.IsZero() {
			timer = time.NewTimer(max(time.Until(deadline), 0))
			due = timer.C
		}
		lineChannel := lines
		if waiting.Kind == "deadline" {
			lineChannel = nil
		}
		stopTimer := func() {
			if timer != nil {
				timer.Stop()
			}
		}
		select {
		case <-ctx.Done():
			stopTimer()
			return ctx.Err()
		case <-options.Interrupt:
			stopTimer()
			if waiting.Kind != "prompt" {
				if err := print(host.Input(":cancel")); err != nil {
					return err
				}
			} else if len(entry) > 0 {
				entry = nil
				if err := print([]string{"(Entry dropped)"}); err != nil {
					return err
				}
			}
		case <-due:
			if err := print(host.Tick()); err != nil {
				return err
			}
		case line := <-lineChannel:
			stopTimer()
			if line.eof {
				if line.err != nil {
					return line.err
				}
				if len(entry) > 0 {
					return print(host.Input(strings.Join(entry, "\n")))
				}
				return nil
			}
			if waiting.Kind == "read" {
				if err := print(host.Read(line.text)); err != nil {
					return err
				}
				continue
			}
			if waiting.Kind == "user" {
				answer, ok := promptAnswer(*waiting.Prompt, line.text)
				if !ok {
					if err := ask(*waiting.Prompt); err != nil {
						return err
					}
				} else if err := print(host.AnswerPrompt(answer)); err != nil {
					return err
				}
				continue
			}
			if len(entry) == 0 {
				if line.text == ":quit" {
					return nil
				}
				// `:fuel` collects a multiline Entry like any other.
				if strings.HasPrefix(line.text, ":") && !host.NeedsMore(line.text) {
					if err := print(host.Input(line.text)); err != nil {
						return err
					}
					continue
				}
				if strings.TrimSpace(line.text) == "" {
					continue
				}
			}
			entry = append(entry, line.text)
			source := strings.Join(entry, "\n")
			if host.NeedsMore(source) {
				continue
			}
			entry = nil
			if err := print(host.Input(source)); err != nil {
				return err
			}
		}
	}
}
