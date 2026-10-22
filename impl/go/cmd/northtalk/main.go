// Command northtalk runs a Script file, the Go REPL, or replays a Session
// Transcript.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/odogono/odgn-talk/impl/go/driver"
	"github.com/odogono/odgn-talk/impl/go/session"
)

const usage = "usage: northtalk [-port n] file.talk [args...]\n       northtalk [-transcript file] [-trace file] [-replay file]"

// usageError exits 2, as a bad command line does.
type usageError struct{ message string }

func (e usageError) Error() string { return e.message }

func main() {
	code, err := run()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		if code == 0 {
			code = 1
		}
	}
	os.Exit(code)
}

// isScriptFile is whether the first argument after the flags is a Script to
// run: it ends in `.talk` or names an existing file (ADR 0126).
func isScriptFile(arg string) bool {
	if strings.HasPrefix(arg, "-") {
		return false
	}
	if strings.HasSuffix(arg, ".talk") {
		return true
	}
	info, err := os.Stat(arg)
	return err == nil && info.Mode().IsRegular()
}

func portOf(value string) (int, error) {
	port, err := strconv.Atoi(value)
	if err != nil || port < 0 || port > 65535 || strings.TrimLeft(value, "0123456789") != "" {
		return 0, usageError{fmt.Sprintf("-port needs a port from 0 to 65535, not %s", value)}
	}
	return port, nil
}

// runFile runs a Script file with the Runner, after the flags are parsed.
func runFile(portFlag string, portSet bool, file string, args []string) (int, error) {
	o := runOptions{file: file, args: args}
	value, set := portFlag, portSet
	if !set {
		value, set = os.Getenv("PORT"), os.Getenv("PORT") != ""
	}
	if set {
		port, err := portOf(value)
		if err != nil {
			return 2, err
		}
		o.port = &port
	}
	stat, err := os.Stdin.Stat()
	if err != nil {
		return 1, err
	}
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	return runScript(o, runIO{
		stdin: os.Stdin, stdout: os.Stdout, stderr: os.Stderr,
		tty:     stat.Mode()&os.ModeCharDevice != 0,
		signals: signals,
		exit:    os.Exit,
	}), nil
}

func run() (int, error) {
	transcript := flag.String("transcript", "", "record the REPL to a Session Transcript")
	tracePath := flag.String("trace", "", "write the Group Trace")
	replay := flag.String("replay", "", "replay a Session Transcript, checking its recorded output")
	port := flag.String("port", "", "run a Script file with every serve on this port (default: PORT)")
	flag.Usage = func() { fmt.Fprintln(flag.CommandLine.Output(), usage); flag.PrintDefaults() }
	flag.Parse()
	set := map[string]bool{}
	flag.Visit(func(f *flag.Flag) { set[f.Name] = true })
	if flag.NArg() > 0 && isScriptFile(flag.Arg(0)) {
		if set["transcript"] || set["trace"] || set["replay"] {
			return 2, usageError{"-transcript, -trace and -replay are for the REPL, not a Script file"}
		}
		return runFile(*port, set["port"], flag.Arg(0), flag.Args()[1:])
	}
	if flag.NArg() > 0 || set["port"] {
		return 2, usageError{usage}
	}
	return 0, repl(*transcript, *tracePath, *replay)
}

func repl(transcriptPath, tracePath, replayPath string) error {
	transcript, replay := &transcriptPath, &replayPath
	var trace *os.File
	env := session.Environment{
		ReadStoreFile:  func(path string) (string, error) { b, err := os.ReadFile(path); return string(b), err },
		WriteStoreFile: func(path, source string) error { return os.WriteFile(path, []byte(source), 0644) },
		ReadFile:       func(path string) (string, error) { b, err := os.ReadFile(path); return string(b), err },
		WriteFile: func(dir, file, source string) error {
			if err := os.MkdirAll(dir, 0755); err != nil {
				return err
			}
			return os.WriteFile(filepath.Join(dir, file), []byte(source), 0644)
		},
	}
	var ioErr error
	if tracePath != "" {
		var err error
		trace, err = os.Create(tracePath)
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
