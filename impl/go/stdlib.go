package northtalk

import (
	"sync"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
)

// Each Standard Library compiles once per process, on first use. WASI linear
// memory cannot shrink, so a fresh instance pays only for the Libraries its
// Scripts name (#585).
var stdlibMu sync.Mutex
var stdlib = map[string]*Library{}
var stdlibCore *Core

func isStandardLibrary(name string) bool {
	_, ok := generated.StandardLibraries[name]
	return ok
}

// standardLibrary compiles name after the Libraries it uses.
func standardLibrary(name string) *Library {
	stdlibMu.Lock()
	defer stdlibMu.Unlock()
	return compileStandardLibrary(name)
}

func compileStandardLibrary(name string) *Library {
	if l := stdlib[name]; l != nil {
		return l
	}
	source := generated.StandardLibraries[name]
	tree, err := syntax.ParseCompact(source)
	if err != nil {
		panic(err)
	}
	for _, n := range tree.Declarations {
		if n.Kind == "use" {
			compileStandardLibrary(n.Text)
		}
	}
	if stdlibCore == nil {
		stdlibCore = New()
	}
	l, err := stdlibCore.compileLibraryParsed(LibrarySource{Name: name, Version: CoreVersions().Language, Source: source}, stdlib, nil, tree, nil)
	if err != nil {
		panic(err)
	}
	l.state.Stdlib = true
	lower.LowerStdlibIntrinsics(l.state.Unit)
	stdlib[name] = l
	return l
}

// addStandardLibraries makes each named Standard Library, and those it
// imports, available to libraries. Other names are left to the caller.
func addStandardLibraries(libraries map[string]*Library, names ...string) {
	for _, name := range names {
		if libraries[name] != nil || !isStandardLibrary(name) {
			continue
		}
		l := standardLibrary(name)
		libraries[name] = l
		for _, imported := range l.imports {
			addStandardLibraries(libraries, imported.Name())
		}
	}
}

// usedNames lists the Libraries a source's `use` declarations name.
func usedNames(tree *syntax.Tree) []string {
	names := []string{}
	if tree == nil {
		return names
	}
	for _, n := range tree.Declarations {
		if n.Kind == "use" {
			names = append(names, n.Text)
		}
	}
	return names
}

func usedNamesIn(source string) []string {
	tree, _ := syntax.ParseCompact(source)
	return usedNames(tree)
}

func importNames(l *Library) []string {
	names := []string{}
	for _, imported := range l.imports {
		names = append(names, imported.Name())
	}
	return names
}
