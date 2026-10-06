package corpus

import (
	"fmt"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
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
		tree, err := syntax.Parse(source)
		if err != nil {
			return nil, err
		}
		var imports []*talk.Library
		for _, n := range tree.Declarations {
			if n.Kind == "use" && setups[n.Text] != nil {
				l, err := compile(n.Text)
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
