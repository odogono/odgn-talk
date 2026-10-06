package northtalk

import (
	"github.com/odogono/odgn-talk/impl/go/internal/replay"
)

func init() {
	replay.Pending = func(group any) []string {
		g := group.(*Group)
		ids := []string{}
		for _, id := range orderedCalls(g.calls) {
			if g.calls[id].pending {
				ids = append(ids, string(id))
			}
		}
		return ids
	}

	replay.Libraries = func(group any) []any {
		g := group.(*Group)
		out := []any{}
		for name, l := range g.libraries {
			if standardLibraries()[name] == nil {
				out = append(out, l)
			}
		}
		return out
	}
}
