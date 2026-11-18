package corpus

import (
	"os"
	"path/filepath"
	"strings"

	"northtalk.org/go/driver"
)

// sessionBackend replays a Session Transcript through the Go session, whose
// Session Host is the Zig one the reactor serves (ADR 0180), and checks its
// Trace. The Zig Core's own corpus covers what the Trace replays.
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
	defer host.Close()
	// The end, as for a Trace Case: Inspect, unless the last input was it.
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
	var out []string
	for _, line := range strings.Split(strings.TrimSuffix(driver.WriteTranscript(items), "\n"), "\n") {
		if line != "" && !strings.HasPrefix(line, "#") {
			out = append(out, line)
		}
	}
	return out, nil
}
