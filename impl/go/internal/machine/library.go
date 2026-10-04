package machine

import (
	"slices"
	"strings"

	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

func functionCode(code *State, name string) string {
	if code.Unit.Kind != "library" {
		return name
	}
	if parts := strings.Split(name, ":"); len(parts) > 1 {
		name = strings.Join(parts[len(parts)-2:], ":")
	}
	return code.Unit.Name + ":" + name
}

// BindLibraryValue copies Function metadata without changing a shared Library
// Constant. Nested values and captured functions take the reading Script's Home.
func BindLibraryValue(v value.Value, home *State) value.Value {
	if v.Kind == value.Function && v.Function != nil {
		fn := *v.Function
		fn.Home, fn.Owner, fn.Group = home.Unit.Name, home, home.Group
		fn.Captures = slices.Clone(fn.Captures)
		for j := range fn.Captures {
			fn.Captures[j].Val = BindLibraryValue(fn.Captures[j].Val, home)
		}
		v.Function = &fn
	}
	if v.Kind == value.List {
		v.Items = slices.Clone(v.Items)
		for j := range v.Items {
			v.Items[j] = BindLibraryValue(v.Items[j], home)
		}
	}
	if v.Kind == value.Map {
		v.Entries = slices.Clone(v.Entries)
		for j := range v.Entries {
			v.Entries[j].Val = BindLibraryValue(v.Entries[j].Val, home)
		}
	}
	return v
}
