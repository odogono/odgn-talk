package corpus

import (
	"fmt"
	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"os"
	"path/filepath"
	"strings"
)

type disassemblyBackend struct{}

func (disassemblyBackend) Support(c Case) string { return "" }

// Disassembly links declarations only. It does not execute Libraries or
// Capabilities, and takes stdlib declarations directly from their Spec source.
func (disassemblyBackend) Run(c Case, _ []Record) ([]string, error) {
	options := check.Options{Imports: map[string]map[string]check.Symbol{}}
	for _, name := range []string{"bytes", "list", "json", "text", "map", "date", "units"} {
		source, e := os.ReadFile(filepath.Join(c.Dir, "../../../spec/stdlib", name+".talk"))
		if e != nil {
			return nil, e
		}
		symbols, e := declarations(string(source))
		if e != nil {
			return nil, e
		}
		options.Imports[name] = symbols
	}
	sources := map[string]string{}
	libraries := map[string]bool{}
	for _, kind := range []string{"libraries", "scripts"} {
		if setups, ok := c.Setup[kind].([]any); ok {
			for _, raw := range setups {
				s := raw.(Setup)
				name := s["name"].(string)
				source, e := os.ReadFile(filepath.Join(c.Dir, s["source"].(string)))
				if e != nil {
					return nil, e
				}
				sources[name] = string(source)
				if kind == "libraries" {
					libraries[name] = true
					symbols, e := declarations(string(source))
					if e != nil {
						return nil, e
					}
					options.Imports[name] = symbols
				}
			}
		}
	}
	if objects, ok := c.Setup["objects"].([]any); ok {
		for _, raw := range objects {
			s := raw.(Setup)
			if name, ok := s["name"].(string); ok {
				options.Objects = append(options.Objects, name)
			}
		}
	}
	var lines []string
	for _, raw := range c.Setup["disassembly"].([]any) {
		s := raw.(Setup)
		name := s["unit"].(string)
		options.Library = libraries[name]
		tree, e := syntax.Parse(sources[name])
		if e != nil {
			return nil, e
		}
		checked := check.Check(tree, options)
		if len(checked.Diagnostics) > 0 {
			return nil, fmt.Errorf("%s: %v", name, checked.Diagnostics)
		}
		unit, e := lower.Compile(checked, name)
		if e != nil {
			return nil, e
		}
		lines = append(lines, strings.Split(strings.TrimSuffix(unit.Disassemble(), "\n"), "\n")...)
	}
	return lines, nil
}
func declarations(source string) (map[string]check.Symbol, error) {
	tree, e := syntax.Parse(source)
	if e != nil {
		return nil, e
	}
	symbols := map[string]check.Symbol{}
	for _, n := range tree.Declarations {
		if n.Private {
			continue
		}
		kind := n.Kind
		if kind == "constant" {
			kind = "definition"
		}
		if kind != "function" && kind != "handler" && kind != "definition" {
			continue
		}
		required := 0
		for _, p := range n.Params {
			if len(p.Children) == 0 {
				required++
			}
		}
		symbols[n.Text] = check.Symbol{Kind: kind, Name: n.Text, Node: n, Required: required, Maximum: len(n.Params)}
	}
	return symbols, nil
}
