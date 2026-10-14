package northtalk

import (
	"maps"
	"slices"
	"sync"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
)

var stdlibOnce sync.Once
var stdlib map[string]*Library

func standardLibraries() map[string]*Library {
	stdlibOnce.Do(func() {
		stdlib = compileStandardLibraries()
	})
	return stdlib
}

func compileStandardLibraries() map[string]*Library {
	libraries := map[string]*Library{}
	c := New()
	var compile func(string) *Library
	compile = func(name string) *Library {
		if l := libraries[name]; l != nil {
			return l
		}
		source := generated.StandardLibraries[name]
		tree, err := syntax.ParseCompact(source)
		if err != nil {
			panic(err)
		}
		for _, n := range tree.Declarations {
			if n.Kind == "use" {
				compile(n.Text)
			}
		}
		l, err := c.compileLibraryParsed(LibrarySource{Name: name, Version: CoreVersions().Language, Source: source}, libraries, nil, tree, nil)
		if err != nil {
			panic(err)
		}
		l.state.Stdlib = true
		lower.LowerStdlibIntrinsics(l.state.Unit)
		libraries[name] = l
		return l
	}
	// Map iteration changes the allocation peak of cold compilation. WASI
	// linear memory cannot shrink, so keep the starting order stable while
	// compile still visits each Library's dependencies before the Library.
	for _, name := range slices.Sorted(maps.Keys(generated.StandardLibraries)) {
		compile(name)
	}
	return libraries
}
