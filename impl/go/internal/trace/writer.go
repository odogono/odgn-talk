// Package trace writes the canonical record ordering from corpus.toml.
package trace

import (
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"strings"
)

func Format(name string, input bool, ids []string, fields map[string]string) string {
	var out strings.Builder
	if input {
		out.WriteString("> ")
	}
	out.WriteString(name)
	for _, id := range ids {
		out.WriteByte(' ')
		out.WriteString(id)
	}
	for _, record := range generated.Corpus.Record {
		if record.Name == name && record.Input == input {
			for _, key := range record.Key {
				if v, ok := fields[key.Key]; ok {
					out.WriteByte(' ')
					out.WriteString(key.Key)
					out.WriteByte('=')
					out.WriteString(v)
				} else if !key.Optional && !(key.Filled && key.Type == "ids") {
					panic("missing Trace key " + name + "." + key.Key)
				}
			}
			return out.String()
		}
	}
	panic("unknown Trace record " + name)
}
