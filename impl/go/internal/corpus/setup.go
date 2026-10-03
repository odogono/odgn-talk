package corpus

import (
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
)

// The Corpus uses the TOML subset below: tables, arrays of tables, inline
// tables, arrays, single-line basic/literal strings, integers and booleans.
// Other TOML types are not part of case.toml's schema and are refused.
type Setup map[string]any
type tomlReader struct {
	text string
	at   int
}

func (r *tomlReader) error() error { return fmt.Errorf("invalid case.toml at byte %d", r.at) }
func (r *tomlReader) take(s string) bool {
	if strings.HasPrefix(r.text[r.at:], s) {
		r.at += len(s)
		return true
	}
	return false
}
func (r *tomlReader) space(lines bool) {
	for r.at < len(r.text) {
		c := r.text[r.at]
		if c == ' ' || c == '\t' || c == '\r' || lines && c == '\n' {
			r.at++
			continue
		}
		if lines && c == '#' {
			for r.at < len(r.text) && r.text[r.at] != '\n' {
				r.at++
			}
			continue
		}
		break
	}
}
func (r *tomlReader) key() (string, error) {
	if r.at < len(r.text) && (r.text[r.at] == '"' || r.text[r.at] == '\'') {
		return r.string()
	}
	start := r.at
	for r.at < len(r.text) {
		c := r.text[r.at]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '-' {
			r.at++
		} else {
			break
		}
	}
	if r.at == start {
		return "", r.error()
	}
	return r.text[start:r.at], nil
}
func (r *tomlReader) string() (string, error) {
	quote := r.text[r.at]
	r.at++
	var out strings.Builder
	for r.at < len(r.text) {
		cp, n := utf8.DecodeRuneInString(r.text[r.at:])
		r.at += n
		if cp == rune(quote) {
			return out.String(), nil
		}
		if cp < 0x20 && cp != '\t' || cp == 0x7f {
			return "", r.error()
		}
		if cp != '\\' || quote == '\'' {
			out.WriteRune(cp)
			continue
		}
		if r.at == len(r.text) {
			return "", r.error()
		}
		esc := r.text[r.at]
		r.at++
		switch esc {
		case '"', '\\':
			out.WriteByte(esc)
		case 'b':
			out.WriteByte('\b')
		case 't':
			out.WriteByte('\t')
		case 'n':
			out.WriteByte('\n')
		case 'f':
			out.WriteByte('\f')
		case 'r':
			out.WriteByte('\r')
		case 'u', 'U':
			count := 4
			if esc == 'U' {
				count = 8
			}
			if r.at+count > len(r.text) {
				return "", r.error()
			}
			s := r.text[r.at : r.at+count]
			for _, c := range s {
				if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
					return "", r.error()
				}
			}
			cp, e := strconv.ParseUint(s, 16, 32)
			if e != nil || cp > utf8.MaxRune || cp >= 0xd800 && cp <= 0xdfff {
				return "", r.error()
			}
			r.at += count
			out.WriteRune(rune(cp))
		default:
			return "", r.error()
		}
	}
	return "", r.error()
}
func (r *tomlReader) value() (any, error) {
	r.space(false)
	if r.at >= len(r.text) {
		return nil, r.error()
	}
	switch r.text[r.at] {
	case '"', '\'':
		return r.string()
	case '[':
		r.at++
		r.space(true)
		var items []any
		if r.take("]") {
			return items, nil
		}
		for {
			v, e := r.value()
			if e != nil {
				return nil, e
			}
			items = append(items, v)
			r.space(true)
			if r.take("]") {
				return items, nil
			}
			if !r.take(",") {
				return nil, r.error()
			}
			r.space(true)
			if r.take("]") {
				return items, nil
			}
		}
	case '{':
		r.at++
		r.space(false)
		table := Setup{}
		if r.take("}") {
			return table, nil
		}
		for {
			r.space(false)
			k, e := r.key()
			if e != nil {
				return nil, e
			}
			r.space(false)
			if !r.take("=") {
				return nil, r.error()
			}
			v, e := r.value()
			if e != nil {
				return nil, e
			}
			if _, exists := table[k]; exists {
				return nil, r.error()
			}
			table[k] = v
			r.space(false)
			if r.take("}") {
				return table, nil
			}
			if !r.take(",") {
				return nil, r.error()
			}
		}
	default:
		start := r.at
		for r.at < len(r.text) && !strings.ContainsRune(" \t\r\n,#]}", rune(r.text[r.at])) {
			r.at++
		}
		s := r.text[start:r.at]
		if s == "true" {
			return true, nil
		}
		if s == "false" {
			return false, nil
		}
		if s == "" {
			return nil, r.error()
		}
		for i, c := range s {
			if c < '0' || c > '9' {
				if i == 0 && (c == '-' || c == '+') && len(s) > 1 {
					continue
				}
				return nil, r.error()
			}
		}
		digits := strings.TrimLeft(s, "+-")
		if len(digits) > 1 && digits[0] == '0' {
			return nil, r.error()
		}
		n, e := strconv.ParseInt(s, 10, 64)
		if e != nil {
			return nil, r.error()
		}
		return n, nil
	}
}
func ReadSetup(text string) (Setup, error) {
	if !utf8.ValidString(text) {
		return nil, fmt.Errorf("invalid UTF-8 case.toml")
	}
	r := tomlReader{text: text}
	root := Setup{}
	table := root
	for {
		r.space(true)
		if r.at == len(text) {
			break
		}
		if r.take("[") {
			array := r.take("[")
			r.space(false)
			var path []string
			for {
				name, e := r.key()
				if e != nil {
					return nil, e
				}
				path = append(path, name)
				r.space(false)
				if !r.take(".") {
					break
				}
				r.space(false)
			}
			if !r.take("]") || array && !r.take("]") {
				return nil, r.error()
			}
			parent := root
			for _, name := range path[:len(path)-1] {
				switch next := parent[name].(type) {
				case Setup:
					parent = next
				case []any:
					if len(next) == 0 {
						return nil, r.error()
					}
					var ok bool
					parent, ok = next[len(next)-1].(Setup)
					if !ok {
						return nil, r.error()
					}
				case nil:
					created := Setup{}
					parent[name] = created
					parent = created
				default:
					return nil, r.error()
				}
			}
			name := path[len(path)-1]
			table = Setup{}
			if array {
				if _, exists := parent[name]; exists {
					if _, ok := parent[name].([]any); !ok {
						return nil, r.error()
					}
				}
				items, _ := parent[name].([]any)
				parent[name] = append(items, table)
			} else {
				if _, exists := parent[name]; exists {
					return nil, r.error()
				}
				parent[name] = table
			}
		} else {
			k, e := r.key()
			if e != nil {
				return nil, e
			}
			r.space(false)
			if !r.take("=") {
				return nil, r.error()
			}
			v, e := r.value()
			if e != nil {
				return nil, e
			}
			if _, exists := table[k]; exists {
				return nil, r.error()
			}
			table[k] = v
		}
		r.space(false)
		if r.at < len(text) && text[r.at] == '#' {
			for r.at < len(text) && text[r.at] != '\n' {
				r.at++
			}
		}
		if r.at < len(text) && !r.take("\n") {
			return nil, r.error()
		}
	}
	kind, ok := root["kind"].(string)
	if !ok || !strings.Contains("|trace|disassembly|transcript|encoding|", "|"+kind+"|") {
		return nil, fmt.Errorf("invalid case kind")
	}
	versions, ok := root["versions"].(Setup)
	if !ok || versions["language"] != generated.Version.Language || versions["costModel"] != strconv.FormatInt(generated.Costs.Version, 10) {
		return nil, fmt.Errorf("unsupported or missing corpus versions")
	}
	for name, v := range root {
		if name == "kind" {
			continue
		}
		allowedTable := false
		for _, entry := range generated.Corpus.Setup {
			if entry.Table == name {
				for _, k := range entry.Kinds {
					allowedTable = allowedTable || k == kind
				}
			}
		}
		if !allowedTable {
			return nil, fmt.Errorf("unexpected case.toml table %s", name)
		}
		tables := []Setup{}
		if single, ok := v.(Setup); ok {
			tables = append(tables, single)
		} else if items, ok := v.([]any); ok {
			for _, item := range items {
				table, ok := item.(Setup)
				if !ok {
					return nil, fmt.Errorf("%s must be tables", name)
				}
				tables = append(tables, table)
			}
		} else {
			return nil, fmt.Errorf("unexpected case.toml key %s", name)
		}
		for _, table := range tables {
			for key := range table {
				valid := false
				for _, entry := range generated.Corpus.Setup {
					if entry.Table == name && entry.Key == key {
						for _, k := range entry.Kinds {
							valid = valid || k == kind
						}
					}
				}
				if !valid {
					return nil, fmt.Errorf("unexpected %s.%s in %s case", name, key, kind)
				}
			}
		}
	}
	return root, nil
}
