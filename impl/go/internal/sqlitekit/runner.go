// Package sqlitekit drives a `sqlite` implementation through the
// language-neutral sqlite kit, `corpus/sqlite-kit/`. Each call goes through
// the factory's Operations and their checks, so a step gives what a Script
// would see.
package sqlitekit

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/corpus"
	"github.com/odogono/odgn-talk/impl/go/internal/hostkit"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

// Subject is one fresh, empty database, opened for one sequence.
type Subject struct {
	Sqlite talk.SqliteImpl
	// Exec runs a setup statement directly, outside every Segment.
	Exec  func(sql string) error
	Close func() error
}

// Sequence is one kit sequence, with the file that holds it.
type Sequence struct {
	File, Name string
	grants     corpus.Setup
	setup      []any
	steps      []any
}

// Sequences reads every sequence in the kit, file by file.
func Sequences(root string) ([]Sequence, error) {
	files, err := filepath.Glob(filepath.Join(root, "*.toml"))
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("No sqlite kit files in %s", root)
	}
	out := []Sequence{}
	for _, file := range files {
		b, err := os.ReadFile(file)
		if err != nil {
			return nil, err
		}
		kit, err := corpus.ReadTOML(string(b))
		if err != nil {
			return nil, fmt.Errorf("%s: %w", filepath.Base(file), err)
		}
		for _, raw := range kit["sequence"].([]any) {
			seq := raw.(corpus.Setup)
			grants, _ := kit["grants"].(corpus.Setup)
			if own, ok := seq["grants"].(corpus.Setup); ok {
				grants = own
			}
			setup, _ := seq["setup"].([]any)
			out = append(out, Sequence{File: filepath.Base(file), Name: seq["name"].(string), grants: grants, setup: setup, steps: seq["steps"].([]any)})
		}
	}
	return out, nil
}

// KeepsStore reports whether the sequence needs a Store kept in the database,
// which a Subject doesn't offer.
func (s Sequence) KeepsStore() bool {
	for _, raw := range s.grants {
		if raw.(corpus.Setup)["capability"] == "store" {
			return true
		}
	}
	return false
}

var segmentBound = map[string]bool{"change": true, "begin": true, "commit": true, "rollback": true}

type kitGrant struct {
	name    string
	binding talk.SqliteBinding
}

// Run runs one sequence on a fresh database, failing at the first step that
// differs.
func Run(open func() (Subject, error), seq Sequence) (err error) {
	if seq.KeepsStore() {
		return fmt.Errorf("%s: %s: the sequence needs a Store kept in the database", seq.File, seq.Name)
	}
	subject, err := open()
	if err != nil {
		return err
	}
	defer func() {
		if closing := subject.Close(); err == nil {
			err = closing
		}
	}()
	for _, raw := range seq.setup {
		if err := subject.Exec(raw.(string)); err != nil {
			return fmt.Errorf("%s: %s: setup: %w", seq.File, seq.Name, err)
		}
	}
	core := talk.New()
	def, err := core.SqliteCapability(subject.Sqlite, talk.Costs{"query": {}, "change": {}, "begin": {}, "commit": {}, "rollback": {}}, 0)
	if err != nil {
		return err
	}
	grants := map[string]kitGrant{}
	var coordinator *talk.SegmentLifecycle
	for name, raw := range seq.grants {
		b := raw.(corpus.Setup)["binding"].(corpus.Setup)
		binding := talk.SqliteBinding{Database: b["database"].(string), MaxRows: b["maxRows"].(int64)}
		if tables, ok := b["tables"].([]any); ok {
			binding.Tables = []string{}
			for _, t := range tables {
				binding.Tables = append(binding.Tables, t.(string))
			}
		}
		grants[name] = kitGrant{name, binding}
		c := subject.Sqlite.Coordinator(binding.Database)
		if coordinator != nil && c != coordinator {
			return fmt.Errorf("%s: %s: every kit Grant shares the database's coordinator", seq.File, seq.Name)
		}
		coordinator = c
	}
	// One Group for every step: Segment ids are unique within it.
	group := core.NewGroup(talk.GroupOptions{})
	// Each begun Segment's enrolled Grants, as the Core gives them to the hooks.
	enrolled := map[string][]talk.SegmentGrant{}
	for i, raw := range seq.steps {
		step := raw.(corpus.Setup)
		in := step["in"].(string)
		name, _ := step["grant"].(string)
		if name == "" {
			name = "db"
		}
		grant, ok := grants[name]
		if !ok {
			return fmt.Errorf("%s: %s, step %d: no Grant %s", seq.File, seq.Name, i+1, name)
		}
		own := talk.SegmentGrant{GrantName: grant.name, Binding: grant.binding}
		var expected, actual string
		if hook, ok := step["hook"].(string); ok {
			segment := enrolled[in]
			if hook == "begin" || segment == nil {
				segment = []talk.SegmentGrant{own}
			}
			if hook == "begin" {
				enrolled[in] = segment
			} else {
				delete(enrolled, in)
			}
			context := talk.SegmentContext{Group: group, ScriptName: "kit", RunID: talk.RunID(in), GrantName: segment[0].GrantName, SegmentID: in, Binding: segment[0].Binding, Grants: segment}
			var result talk.EffectResult
			switch hook {
			case "begin":
				result = coordinator.Begin(context)
			case "commit":
				result = coordinator.Commit(context)
			case "rollback":
				result = coordinator.Rollback(context)
			default:
				return fmt.Errorf("%s: %s, step %d: unknown hook %s", seq.File, seq.Name, i+1, hook)
			}
			status, _ := step["status"].(string)
			if status == "" {
				status = "ok"
			}
			expected, actual = "status "+status, "status "+string(result.Status)
			if result.Detail != "" {
				actual += " (" + result.Detail + ")"
			}
			if result.Status == talk.EffectStatus(status) {
				actual = expected
			}
		} else {
			operation := step["do"].(string)
			if segment := enrolled[in]; segment != nil && segmentBound[operation] && !slices.ContainsFunc(segment, func(g talk.SegmentGrant) bool { return g.GrantName == grant.name }) {
				enrolled[in] = append(segment, own)
			}
			args := []any{}
			if operation == "query" || operation == "change" {
				sql, _ := talk.Text(step["sql"].(string))
				source, _ := step["params"].(string)
				if source == "" {
					source = "[]"
				}
				params, err := display(source)
				if err != nil {
					return err
				}
				args = append(args, sql, params)
				if max, ok := step["max"].(int64); ok {
					args = append(args, talk.Int(max))
				}
			}
			if source, ok := step["error"].(string); ok {
				want, err := display(source)
				if err != nil {
					return err
				}
				expected = "error " + want.String()
			} else {
				source, _ := step["gives"].(string)
				if source == "" {
					source = "nothing"
				}
				want, err := display(source)
				if err != nil {
					return err
				}
				expected = "gives " + want.String()
			}
			v, err := hostkit.Immediate(group, def, operation, in, grant.name, grant.binding, args)
			if err != nil {
				actual = "error " + errorOf(err)
			} else {
				actual = "gives " + v.(talk.Value).String()
			}
		}
		if actual != expected {
			return fmt.Errorf("%s: %s, step %d: expected %s; got %s", seq.File, seq.Name, i+1, expected, actual)
		}
	}
	return nil
}

// errorOf writes an error as the kit does: its code and fields, without a
// `sql` failure's reason, since SQLite's text isn't portable.
func errorOf(err error) string {
	var failure *talk.ScriptError
	if !errors.As(err, &failure) {
		return err.Error()
	}
	code, _ := talk.Text(failure.Code)
	fields := []talk.Pair{talk.KV("code", code)}
	for _, p := range failure.Data.Entries() {
		if failure.Code == "sql" && p.Key == "reason" && p.Val.Kind() == talk.KindText {
			continue
		}
		fields = append(fields, p)
	}
	m, _ := talk.Map(fields...)
	return m.String()
}

func display(source string) (talk.Value, error) {
	v, err := value.ParseDisplay(strings.TrimSpace(source), nil)
	if err != nil {
		return talk.Nothing, fmt.Errorf("%q: %w", source, err)
	}
	b, err := value.Encode(v, false)
	if err != nil {
		return talk.Nothing, err
	}
	return talk.DecodeValue(b, nil)
}
