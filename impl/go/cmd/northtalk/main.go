// Command northtalk runs the Go REPL or replays a Session Transcript.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"

	"github.com/odogono/odgn-talk/impl/go/driver"
	"github.com/odogono/odgn-talk/impl/go/session"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	transcript := flag.String("transcript", "", "record the REPL to a Session Transcript")
	tracePath := flag.String("trace", "", "write the Group Trace")
	replay := flag.String("replay", "", "replay a Session Transcript, checking its recorded output")
	flag.Parse()
	if flag.NArg() > 0 {
		return fmt.Errorf("usage: northtalk [-transcript file] [-trace file] [-replay file]")
	}
	var trace *os.File
	env := session.Environment{
		ReadFile: func(path string) (string, error) { b, err := os.ReadFile(path); return string(b), err },
		WriteFile: func(dir, file, source string) error {
			if err := os.MkdirAll(dir, 0755); err != nil {
				return err
			}
			return os.WriteFile(filepath.Join(dir, file), []byte(source), 0644)
		},
	}
	var ioErr error
	if *tracePath != "" {
		var err error
		trace, err = os.Create(*tracePath)
		if err != nil {
			return err
		}
		defer trace.Close()
		env.Trace = func(line string) {
			if _, err := fmt.Fprintln(trace, line); err != nil && ioErr == nil {
				ioErr = err
			}
		}
	}
	if *replay != "" {
		if *transcript != "" {
			return fmt.Errorf("-transcript cannot be combined with -replay")
		}
		b, err := os.ReadFile(*replay)
		if err != nil {
			return err
		}
		recorded, err := driver.ParseTranscript(string(b))
		if err != nil {
			return err
		}
		_, items, err := driver.ReplayTranscript(recorded, env.Trace)
		if err != nil {
			return err
		}
		// Comments are preserved; output and the recorder must both agree.
		if driver.WriteTranscript(items) != string(b) {
			return fmt.Errorf("Session Transcript diverged: %s", *replay)
		}
		for _, item := range items {
			if item.Kind == "output" {
				if _, err := fmt.Fprintln(os.Stdout, item.Text); err != nil {
					return err
				}
			}
		}
		return ioErr
	}
	var recording *os.File
	if *transcript != "" {
		var err error
		recording, err = os.Create(*transcript)
		if err != nil {
			return err
		}
		defer recording.Close()
		env.Record = func(i session.Item) {
			if _, err := recording.WriteString(driver.WriteTranscript([]session.Item{i})); err != nil && ioErr == nil {
				ioErr = err
			}
		}
	}
	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, os.Interrupt)
	defer signal.Stop(interrupts)
	stat, err := os.Stdin.Stat()
	if err != nil {
		return err
	}
	tty := stat.Mode()&os.ModeCharDevice != 0 && !strings.HasPrefix(os.Getenv("TERM"), "dumb")
	if err := driver.RunREPL(context.Background(), os.Stdin, os.Stdout, driver.REPLOptions{Environment: env, Prompt: tty, Interrupt: interrupts}); err != nil {
		return err
	}
	return ioErr
}
