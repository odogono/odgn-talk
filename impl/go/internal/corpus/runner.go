package corpus

import (
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

type Case struct {
	Name, Dir, Kind string
	Setup           Setup
}

// Backend keeps Trace production outside the runner. #251 can supply replay
// through this interface without changing selection or divergence reporting.
// Support returns an empty reason when the case can run. Run returns complete
// records, including the Host Inputs, exactly as the Trace writer produced them.
type Backend interface {
	Support(Case) string
	Run(Case, []Record) ([]string, error)
}
type Runner struct {
	Root     string
	Output   io.Writer
	Backends map[string]Backend
}

func Discover(root string, selection []string) ([]Case, error) {
	root, e := filepath.Abs(root)
	if e != nil {
		return nil, e
	}
	names := map[string]bool{}
	if len(selection) == 0 {
		e = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if !entry.IsDir() && entry.Name() == "case.toml" {
				names[filepath.Dir(path)] = true
			}
			return nil
		})
		if e != nil {
			return nil, e
		}
	} else {
		for _, selected := range selection {
			path := selected
			if !filepath.IsAbs(path) {
				path = filepath.Join(root, path)
			}
			path = filepath.Clean(path)
			if _, e := os.Stat(filepath.Join(path, "case.toml")); e != nil {
				return nil, fmt.Errorf("unknown case %s: %w", selected, e)
			}
			names[path] = true
		}
	}
	paths := make([]string, 0, len(names))
	for name := range names {
		paths = append(paths, name)
	}
	slices.Sort(paths)
	cases := make([]Case, 0, len(paths))
	for _, dir := range paths {
		b, e := os.ReadFile(filepath.Join(dir, "case.toml"))
		if e != nil {
			return nil, e
		}
		setup, e := ReadSetup(string(b))
		if e != nil {
			return nil, fmt.Errorf("%s: %w", dir, e)
		}
		name, e := filepath.Rel(root, dir)
		if e != nil {
			return nil, e
		}
		cases = append(cases, Case{filepath.ToSlash(name), dir, setup["kind"].(string), setup})
	}
	return cases, nil
}
func (r Runner) support(c Case) string {
	if c.Kind == "encoding" {
		if objects, ok := c.Setup["objects"].([]any); ok && len(objects) > 0 {
			return "Host Object registration is not implemented"
		}
		return ""
	}
	if backend := r.Backends[c.Kind]; backend != nil {
		return backend.Support(c)
	}
	return c.Kind + " execution is not implemented"
}
func (r Runner) execute(c Case) (int, error) {
	if c.Kind == "encoding" {
		return runEncoding(c)
	}
	var records []Record
	var expected []string
	filename := "case.trace"
	if c.Kind == "disassembly" {
		units, ok := c.Setup["disassembly"].([]any)
		if !ok {
			return 0, fmt.Errorf("missing disassembly tables")
		}
		for _, raw := range units {
			setup := raw.(Setup)
			filename := setup["expected"].(string)
			b, e := os.ReadFile(filepath.Join(c.Dir, filename))
			if e != nil {
				return 0, e
			}
			expected = append(expected, strings.Split(strings.TrimSuffix(string(b), "\n"), "\n")...)
		}
		actual, e := r.Backends[c.Kind].Run(c, nil)
		if e != nil {
			return 0, e
		}
		if e := Compare(c.Name, expected, actual); e != nil {
			return 0, e
		}
		return len(actual), nil
	} else if c.Kind == "transcript" {
		filename = "session.transcript"
	}
	b, e := os.ReadFile(filepath.Join(c.Dir, filename))
	if e != nil {
		return 0, e
	}
	if c.Kind == "trace" {
		records, e = ParseTrace(string(b))
		if e != nil {
			return 0, e
		}
		for _, record := range records {
			expected = append(expected, record.Raw)
		}
	} else {
		for _, line := range strings.Split(strings.TrimSuffix(string(b), "\n"), "\n") {
			if line != "" && !strings.HasPrefix(line, "#") {
				expected = append(expected, line)
			}
		}
	}
	actual, e := r.Backends[c.Kind].Run(c, records)
	if e != nil {
		return 0, e
	}
	if e := Compare(c.Name, expected, actual); e != nil {
		return 0, e
	}
	return len(actual), nil
}
func Compare(name string, expected, actual []string) error {
	for i := 0; i < max(len(expected), len(actual)); i++ {
		want, got := "<end>", "<end>"
		if i < len(expected) {
			want = expected[i]
		}
		if i < len(actual) {
			got = actual[i]
		}
		if want != got {
			return fmt.Errorf("%s: line %d\n  expected: %s\n  actual:   %s", name, i+1, want, got)
		}
	}
	return nil
}
func (r Runner) Run(selection []string, list bool) error {
	cases, e := Discover(r.Root, selection)
	if e != nil {
		return e
	}
	var failures []error
	for _, c := range cases {
		reason := r.support(c)
		if list {
			status := "supported"
			if reason != "" {
				status = "deferred: " + reason
			}
			fmt.Fprintf(r.Output, "%s (%s; %s)\n", c.Name, c.Kind, status)
			continue
		}
		if reason != "" {
			fmt.Fprintf(r.Output, "SKIP %s (%s)\n", c.Name, reason)
			if len(selection) > 0 {
				failures = append(failures, fmt.Errorf("%s: %s", c.Name, reason))
			}
			continue
		}
		n, e := r.execute(c)
		if e != nil {
			fmt.Fprintln(r.Output, e)
			failures = append(failures, e)
		} else {
			fmt.Fprintf(r.Output, "PASS %s (%d lines)\n", c.Name, n)
		}
	}
	if len(failures) > 0 {
		return fmt.Errorf("%d corpus case(s) failed", len(failures))
	}
	return nil
}

// CheckPassing is the CI gate. A new passing case is reported, but only a
// regression in the committed list (or a malformed case/list) fails this gate.
func (r Runner) CheckPassing(path string) error {
	b, e := os.ReadFile(path)
	if e != nil {
		return e
	}
	required := map[string]bool{}
	for _, line := range strings.Split(string(b), "\n") {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.TrimSpace(line) != line || required[line] {
			return fmt.Errorf("invalid or duplicate passing-list entry %q", line)
		}
		required[line] = true
	}
	cases, e := Discover(r.Root, nil)
	if e != nil {
		return e
	}
	failed := false
	for _, c := range cases {
		must := required[c.Name]
		delete(required, c.Name)
		reason := r.support(c)
		if reason != "" {
			if must {
				fmt.Fprintf(r.Output, "FAIL %s (%s)\n", c.Name, reason)
				failed = true
			}
			continue
		}
		n, e := r.execute(c)
		if e != nil {
			fmt.Fprintln(r.Output, e)
			if must {
				failed = true
			}
		} else if must {
			fmt.Fprintf(r.Output, "PASS %s (%d lines)\n", c.Name, n)
		} else {
			fmt.Fprintf(r.Output, "NEW PASS %s (%d lines; add to corpus-passing.txt)\n", c.Name, n)
		}
	}
	for name := range required {
		fmt.Fprintf(r.Output, "FAIL %s (listed case does not exist)\n", name)
		failed = true
	}
	if failed {
		return fmt.Errorf("Go corpus passing-list regression")
	}
	return nil
}
func runEncoding(c Case) (int, error) {
	b, e := os.ReadFile(filepath.Join(c.Dir, "case.encoding"))
	if e != nil {
		return 0, e
	}
	text := string(b)
	if text != "" && !strings.HasSuffix(text, "\n") {
		return 0, fmt.Errorf("encoding file must end with LF")
	}
	count := 0
	for i, line := range strings.Split(strings.TrimSuffix(text, "\n"), "\n") {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		reader := value.Reader{Text: line}
		v, e := reader.Value()
		if e != nil {
			return 0, fmt.Errorf("%s: line %d: %w", c.Name, i+1, e)
		}
		display := line[:reader.At]
		if !reader.Take(" => ") {
			return 0, fmt.Errorf("%s: line %d: missing encoding separator", c.Name, i+1)
		}
		host, e := construct(v)
		if e != nil {
			return 0, e
		}
		encoded, e := talk.EncodeValue(host)
		if e != nil {
			return 0, e
		}
		expected := line[reader.At:]
		if string(encoded) != expected {
			return 0, fmt.Errorf("%s: line %d (%s)\n  expected: %s\n  actual:   %s", c.Name, i+1, display, expected, encoded)
		}
		count++
	}
	return count, nil
}

// construct crosses the actual Host constructors, as chapter 11 requires.
// Replay may resolve opaque handles while retaining the public constructors.
func construct(v value.Value) (talk.Value, error) {
	return constructWith(v, nil)
}

func constructWith(v value.Value, resolve func(value.Value) (talk.Value, error)) (talk.Value, error) {
	switch v.Kind {
	case value.Nothing:
		return talk.Nothing, nil
	case value.Boolean:
		return talk.Bool(v.Bool), nil
	case value.Number:
		return talk.Dec(v.Number.String())
	case value.Quantity:
		n, e := talk.Dec(v.Number.String())
		if e != nil {
			return talk.Nothing, e
		}
		d, _ := n.AsDec()
		return talk.Quantity(d, v.Unit.String())
	case value.Text:
		return talk.Text(v.Text)
	case value.Bytes:
		return talk.Bytes(v.Bytes), nil
	case value.CivilDate:
		return talk.CivilDate(talk.DateFields(v.Date))
	case value.Instant:
		return talk.Instant(v.Seconds, v.Nanos)
	case value.List, value.Range:
		items := make([]talk.Value, len(v.Items))
		for i, item := range v.Items {
			var e error
			items[i], e = constructWith(item, resolve)
			if e != nil {
				return talk.Nothing, e
			}
		}
		if v.Kind == value.Range {
			return talk.Range(items[0], items[1])
		}
		return talk.List(items...), nil
	case value.Map:
		pairs := make([]talk.Pair, len(v.Entries))
		for i, p := range v.Entries {
			item, e := constructWith(p.Val, resolve)
			if e != nil {
				return talk.Nothing, e
			}
			pairs[i] = talk.KV(p.Key, item)
		}
		return talk.Map(pairs...)
	case value.Pattern:
		return talk.DecodeValue([]byte(`{"$pattern":`+value.JSONString(v.Text, false)+`}`), nil)
	}
	if resolve != nil {
		return resolve(v)
	}
	return talk.Nothing, fmt.Errorf("opaque Host value requires replay binding")
}
