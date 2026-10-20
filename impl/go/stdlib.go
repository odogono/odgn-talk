package northtalk

import (
	"regexp"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
)

func isStandardLibrary(name string) bool {
	_, ok := generated.StandardLibraries[name]
	return ok
}

// useFrom finds each top-level `use … from Library` declaration.
var useFrom = regexp.MustCompile(`(?m)^[ \t]*use\s[^\n]*?\bfrom\s+([^\s,]+)`)

// usedNamesIn lists the Libraries a source's `use` declarations name.
func usedNamesIn(source string) []string {
	names := []string{}
	for _, m := range useFrom.FindAllStringSubmatch(source, -1) {
		names = append(names, m[1])
	}
	return names
}
