package corpus

import (
	"fmt"
	"regexp"
	"slices"
	"strings"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

type Field struct {
	Key, Raw string
	Value    value.Value
}
type Record struct {
	Name   string
	Input  bool
	IDs    []string
	Fields []Field
	Line   int
	Raw    string
}

var idPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_./:+-]*$`)
var keyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]*$`)
var countPattern = regexp.MustCompile(`^(?:0|[1-9][0-9]*)$`)
var atPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_./:+-]*:(?:0|[1-9][0-9]*)$`)
var posPattern = regexp.MustCompile(`^[1-9][0-9]*:[1-9][0-9]*$`)
var hexPattern = regexp.MustCompile(`^[0-9a-f]+$`)

func ParseTrace(text string) ([]Record, error) {
	if text != "" && !strings.HasSuffix(text, "\n") {
		return nil, fmt.Errorf("Trace must end with LF")
	}
	var records []Record
	for i, line := range strings.Split(strings.TrimSuffix(text, "\n"), "\n") {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		record, e := parseRecord(line)
		if e != nil {
			return nil, fmt.Errorf("Trace line %d: %w", i+1, e)
		}
		record.Line = i + 1
		records = append(records, record)
	}
	return records, nil
}
func parseRecord(line string) (Record, error) {
	record := Record{Raw: line}
	r := value.Reader{Text: line}
	record.Input = r.Take("> ")
	start := r.At
	for r.At < len(line) && (line[r.At] >= 'a' && line[r.At] <= 'z' || line[r.At] == '-') {
		r.At++
	}
	record.Name = line[start:r.At]
	var schema *generated.CorpusTableRecordEntry
	for i := range generated.Corpus.Record {
		if generated.Corpus.Record[i].Name == record.Name && generated.Corpus.Record[i].Input == record.Input {
			schema = &generated.Corpus.Record[i]
			break
		}
	}
	if schema == nil || record.Input != schema.Input {
		return record, fmt.Errorf("unknown record or incorrect input prefix: %s", record.Name)
	}
	token := func() string {
		start := r.At
		for r.At < len(line) && line[r.At] != ' ' {
			r.At++
		}
		return line[start:r.At]
	}
	for _, id := range schema.Ids {
		at := r.At
		// An author may leave out the ids the Core assigns (chapter 11).
		omittable := strings.HasSuffix(id, "?") || record.Input && (id == "delivery" || id == "broadcast" || id == "save")
		if !r.Take(" ") {
			if omittable {
				continue
			}
			return record, fmt.Errorf("missing id %s", id)
		}
		s := token()
		if strings.Contains(s, "=") {
			r.At = at
			if omittable {
				continue
			}
			return record, fmt.Errorf("missing id %s", id)
		}
		if !idPattern.MatchString(s) {
			return record, fmt.Errorf("invalid id %s", s)
		}
		record.IDs = append(record.IDs, s)
	}
	previous := -1
	for r.At < len(line) {
		if !r.Take(" ") {
			return record, r.Error()
		}
		start := r.At
		for r.At < len(line) && line[r.At] != '=' && line[r.At] != ' ' {
			r.At++
		}
		key := line[start:r.At]
		if !keyPattern.MatchString(key) || !r.Take("=") {
			return record, r.Error()
		}
		keyType := "value"
		var allowed []string
		index := -1
		for i, k := range schema.Key {
			if k.Key == key {
				index = i
				keyType = k.Type
				allowed = k.Words
				break
			}
		}
		if record.Name != "vars" && (index < 0 || index <= previous) {
			return record, fmt.Errorf("unexpected or unordered key %s", key)
		}
		previous = index
		for _, field := range record.Fields {
			if field.Key == key {
				return record, fmt.Errorf("duplicate key %s", key)
			}
		}
		start = r.At
		v := value.Value{}
		switch keyType {
		case "value", "instant":
			var e error
			if record.Input && key == "source" && (record.Name == "reload" || record.Name == "extend" || record.Name == "replace-library") {
				// Source transport preserves scalars for Code identity (chapter 11).
				// Ordinary Script Text Values still go through NewText below.
				var source string
				source, e = r.TextValue()
				v = value.Value{Kind: value.Text, Text: source}
			} else {
				v, e = r.Value()
			}
			if e != nil {
				return record, e
			}
			if keyType == "instant" && v.Kind != value.Instant {
				return record, fmt.Errorf("%s must be an Instant", key)
			}
		case "target":
			if strings.HasPrefix(line[r.At:], "<object ") {
				var e error
				v, e = r.Value()
				if e != nil {
					return record, e
				}
			} else if !idPattern.MatchString(token()) {
				return record, fmt.Errorf("invalid target")
			}
		case "ids":
			if !r.Take("[") {
				return record, r.Error()
			}
			if !r.Take("]") {
				for {
					begin := r.At
					for r.At < len(line) && line[r.At] != ',' && line[r.At] != ']' {
						r.At++
					}
					if !idPattern.MatchString(line[begin:r.At]) {
						return record, fmt.Errorf("invalid id list")
					}
					if r.Take("]") {
						break
					}
					if !r.Take(", ") {
						return record, r.Error()
					}
				}
			}
		case "id":
			if !idPattern.MatchString(token()) {
				return record, fmt.Errorf("invalid id")
			}
		case "word":
			if len(allowed) == 0 {
				if key == "end" {
					for _, entry := range generated.Corpus.End {
						allowed = append(allowed, entry.Word)
					}
				}
				if key == "kind" && record.Name == "note" {
					for _, entry := range generated.Corpus.Note {
						allowed = append(allowed, entry.Word)
					}
				}
			}
			if !slices.Contains(allowed, token()) {
				return record, fmt.Errorf("invalid word for %s", key)
			}
		case "count":
			if !countPattern.MatchString(token()) {
				return record, fmt.Errorf("invalid count")
			}
		case "at":
			if !atPattern.MatchString(token()) {
				return record, fmt.Errorf("invalid code position")
			}
		case "pos":
			if !posPattern.MatchString(token()) {
				return record, fmt.Errorf("invalid source position")
			}
		case "hex":
			if !hexPattern.MatchString(token()) {
				return record, fmt.Errorf("invalid hex")
			}
		default:
			return record, fmt.Errorf("unknown key type %s", keyType)
		}
		record.Fields = append(record.Fields, Field{key, line[start:r.At], v})
	}
	for _, key := range schema.Key {
		if key.Optional || key.Filled && record.Input {
			continue
		}
		found := false
		for _, f := range record.Fields {
			found = found || f.Key == key.Key
		}
		if !found {
			return record, fmt.Errorf("missing key %s", key.Key)
		}
	}
	return record, nil
}
