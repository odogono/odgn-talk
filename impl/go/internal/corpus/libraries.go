package corpus

import (
	"fmt"
	"regexp"

	talk "github.com/odogono/odgn-talk/impl/go"
)

func setupLibraries(core *talk.Core, setup Setup, declarations talk.GrantDecls, readSource func(Setup) (string, error)) (map[string]*talk.Library, error) {
	setups := map[string]Setup{}
	rows, _ := setup["libraries"].([]any)
	for _, raw := range rows {
		row := raw.(Setup)
		setups[row["name"].(string)] = row
	}
	libraries := map[string]*talk.Library{}
	compiling := map[string]bool{}
	var compile func(string) (*talk.Library, error)
	compile = func(name string) (*talk.Library, error) {
		if l := libraries[name]; l != nil {
			return l, nil
		}
		if compiling[name] {
			return nil, fmt.Errorf("Library cycle: %s", name)
		}
		row := setups[name]
		compiling[name] = true
		source, err := readSource(row)
		if err != nil {
			return nil, err
		}
		var imports []*talk.Library
		for _, m := range useFrom.FindAllStringSubmatch(source, -1) {
			if setups[m[1]] != nil {
				l, err := compile(m[1])
				if err != nil {
					return nil, err
				}
				imports = append(imports, l)
			}
		}
		version, _ := row["version"].(string)
		l, err := core.CompileLibrary(talk.LibrarySource{Name: name, Version: version, Source: source}, imports, declarations)
		if err != nil {
			return nil, err
		}
		libraries[name] = l
		delete(compiling, name)
		return l, nil
	}
	for name := range setups {
		if _, err := compile(name); err != nil {
			return nil, err
		}
	}
	return libraries, nil
}

// useFrom finds each top-level `use … from Library` declaration.
var useFrom = regexp.MustCompile(`(?m)^use\s[^\n]*?\bfrom\s+([^\s,]+)`)
