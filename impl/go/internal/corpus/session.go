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
	replayed, err := runReplayPair(Case{Name: c.Name, Dir: dir, Kind: "trace", Setup: setup}, records, sessionStoreReplies(host, records))
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
		if cap == "store" {
			grants[name].(Setup)["binding"] = h.GrantBinding(name)
		}
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
	seen := map[string]bool{}
	for _, cap := range h.Grants() {
		if seen[cap] {
			continue
		}
		seen[cap] = true
		if cap == "clock" {
			standard = append(standard, Setup{"capability": "clock", "costs": Setup{"now": Setup{"fuel": int64(0)}}})
		}
		if cap == "user" {
			costs := Setup{}
			for _, name := range []string{"confirm", "choose", "enter", "notify"} {
				costs[name] = Setup{"fuel": int64(0)}
			}
			standard = append(standard, Setup{"capability": "user", "costs": costs})
		}
		if cap == "store" {
			costs := Setup{}
			for _, name := range []string{"get", "keys", "set", "delete", "increment", "swap"} {
				fuel := int64(4)
				if name == "get" || name == "keys" {
					fuel = 2
				}
				costs[name] = Setup{"fuel": fuel}
			}
			standard = append(standard, Setup{"capability": "store", "costs": costs})
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
	return Setup{"sessionObjects": h.ObjectTranscript(), "operations": operations, "standard": standard, "libraries": libraries, "scripts": []any{Setup{"name": "session", "source": "session.talk", "grants": grants}}}, nil
}

// Session Store results belong to the Host, outside the Trace's Host Inputs.
// Seed them as invisible Stubs for independent ordinary/save-restore replay;
// loaded files and committed contents are never copied into the replay Core.
func sessionStoreReplies(h *session.Host, records []Record) func(*operationReplay) {
	grants := h.Grants()
	return func(o *operationReplay) {
		for _, r := range records {
			if r.Input || len(r.IDs) == 0 {
				continue
			}
			fields := map[string]Field{}
			for _, f := range r.Fields {
				fields[f.Key] = f
			}
			if r.Name == "call" {
				grant, op, ok := strings.Cut(fields["op"].Raw, ".")
				if failure, failed := fields["error"]; ok && failed && grants[grant] == "user" {
					o.startFailures[r.IDs[0]] = failure
					continue
				}
				if !ok || grants[grant] != "store" {
					continue
				}
				stub := map[string]Field{}
				if result, ok := fields["result"]; ok {
					stub["value"] = result
				}
				if failure, ok := fields["error"]; ok {
					stub["error"] = failure
				}
				if charged, ok := fields["charged"]; ok {
					stub["charge"] = charged
				}
				o.stubs["store."+op] = append(o.stubs["store."+op], stub)
			}
			if r.Name == "effect" && grants[fields["grant"].Raw] == "store" {
				script, _, _ := strings.Cut(r.IDs[0], "/")
				key := script + "." + fields["grant"].Raw + "." + fields["phase"].Raw
				o.effectStubs[key] = append(o.effectStubs[key], map[string]Field{"status": fields["status"]})
			}
		}
	}
}
