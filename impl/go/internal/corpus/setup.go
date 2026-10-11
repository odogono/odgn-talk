package corpus

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/toml"
)

// Setup holds a case's tables in the shared Corpus TOML subset.
type Setup = toml.Table

// ReadTOML reads kit data without imposing the Trace Case schema.
func ReadTOML(text string) (Setup, error) { return toml.ReadTOML(text) }

func ReadSetup(text string) (Setup, error) {
	root, err := ReadTOML(text)
	if err != nil {
		return nil, err
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
