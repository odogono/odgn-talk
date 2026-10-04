package northtalk

import (
	"sync"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
)

var stdlibOnce sync.Once
var stdlib map[string]*Library

func standardLibraries() map[string]*Library {
	stdlibOnce.Do(func() {
		stdlib = map[string]*Library{}
		c := New()
		var compile func(string) *Library
		compile = func(name string) *Library {
			if l := stdlib[name]; l != nil {
				return l
			}
			source := generated.StandardLibraries[name]
			tree, err := syntax.Parse(source)
			if err != nil {
				panic(err)
			}
			for _, n := range tree.Declarations {
				if n.Kind == "use" {
					compile(n.Text)
				}
			}
			l, err := c.compileLibrary(LibrarySource{Name: name, Version: CoreVersions().Language, Source: source}, stdlib, nil)
			if err != nil {
				panic(err)
			}
			l.state.Stdlib = true
			stdlib[name] = l
			return l
		}
		for name := range generated.StandardLibraries {
			compile(name)
		}
	})
	return stdlib
}
