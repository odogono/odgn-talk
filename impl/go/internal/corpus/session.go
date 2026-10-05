package corpus

import (
	"os"
	"path/filepath"
	"strings"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/driver"
	"github.com/odogono/odgn-talk/impl/go/session"
)

type sessionBackend struct{}

func (sessionBackend) Support(c Case) string { return "" }
func (sessionBackend) Run(c Case, _ []Record) ([]string, error) {
	b, err := os.ReadFile(filepath.Join(c.Dir, "session.transcript"))
	if err != nil {
		return nil, err
	}
	recorded, err := driver.ParseTranscript(string(b))
	if err != nil {
		return nil, err
	}
	var trace []string
	host, items, err := driver.ReplayTranscript(recorded, func(line string) { trace = append(trace, line) })
	if err != nil {
		return nil, err
	}
	lastInput := ""
	for _, line := range trace {
		if strings.HasPrefix(line, "> ") {
			lastInput = line
		}
	}
	if lastInput != "> vars" {
		host.Inspect()
	}
	expectedBytes, err := os.ReadFile(filepath.Join(c.Dir, "case.trace"))
	if err != nil {
		return nil, err
	}
	records, err := ParseTrace(string(expectedBytes))
	if err != nil {
		return nil, err
	}
	var expected []string
	for _, r := range records {
		expected = append(expected, r.Raw)
	}
	if err := Compare(c.Name+" case.trace", expected, trace); err != nil {
		return nil, err
	}
	// Replay the Trace independently through the ordinary and snapshot backends.
	dir, err := os.MkdirTemp("", "northtalk-session-case-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	setup, err := sessionSetup(host, dir)
	if err != nil {
		return nil, err
	}
	replayed, err := (executionBackend{}).Run(Case{Name: c.Name, Dir: dir, Kind: "trace", Setup: setup}, records)
	if err != nil {
		return nil, err
	}
	if err := Compare(c.Name+" Trace replay", expected, replayed); err != nil {
		return nil, err
	}
	var out []string
	for _, line := range strings.Split(strings.TrimSuffix(driver.WriteTranscript(items), "\n"), "\n") {
		if line != "" && !strings.HasPrefix(line, "#") {
			out = append(out, line)
		}
	}
	return out, nil
}
func sessionSetup(h *session.Host, dir string) (Setup, error) {
	grants := Setup{"console": Setup{"ops": "all"}}
	for name, cap := range h.Grants() {
		grants[name] = Setup{"capability": cap, "ops": "all"}
	}
	var operations []any
	for _, m := range h.MockOperations() {
		args := []any{}
		for range 8 {
			args = append(args, Setup{"optional": "any"})
		}
		mode := []string{"immediate", "suspending", "fire-and-forget"}[m.Mode]
		op := Setup{"capability": m.Capability, "name": m.Operation, "mode": mode, "args": args, "cost": Setup{"fuel": int64(0)}}
		if m.Mode != talk.FireAndForget {
			op["result"] = "any"
		}
		operations = append(operations, op)
	}
	standard := []any{Setup{"capability": "console", "costs": Setup{"write": Setup{"fuel": int64(0)}, "read": Setup{"fuel": int64(0)}}}}
	for _, cap := range h.Grants() {
		if cap == "clock" {
			standard = append(standard, Setup{"capability": "clock", "costs": Setup{"now": Setup{"fuel": int64(0)}}})
			break
		}
	}
	var libraries []any
	for _, l := range h.UserLibraries() {
		file := l.Name + ".talk"
		if err := os.WriteFile(filepath.Join(dir, file), []byte(l.Source), 0600); err != nil {
			return nil, err
		}
		libraries = append(libraries, Setup{"name": l.Name, "version": l.Version, "source": file})
	}
	if err := os.WriteFile(filepath.Join(dir, "session.talk"), nil, 0600); err != nil {
		return nil, err
	}
	return Setup{"operations": operations, "standard": standard, "libraries": libraries, "scripts": []any{Setup{"name": "session", "source": "session.talk", "grants": grants}}}, nil
}
