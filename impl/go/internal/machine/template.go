package machine

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

// Replace only splice nodes from the original template, never quoted text or
// text introduced by an earlier splice. Offsets refer to the parser wrapper.
func spliceTemplate(source string, values []value.Value) (string, error) {
	const prefix = "on pattern\n put "
	tree, e := syntax.Parse(prefix + source + " into result\nend pattern\n")
	if e != nil {
		return source, e
	}
	var out strings.Builder
	at := 0
	var walk func(*syntax.Node) error
	walk = func(n *syntax.Node) error {
		if n.Kind == "splice" {
			first, last := n.Token.Start-len(prefix), n.End.End-len(prefix)
			index, e := strconv.Atoi(strings.TrimSpace(source[first+1 : last-1]))
			if e != nil || index < 1 || index > len(values) {
				return fmt.Errorf("invalid pattern template splice")
			}
			out.WriteString(source[at:first])
			v := values[index-1]
			if v.Kind == value.Text {
				out.WriteString("(" + v.Display() + ")")
			} else {
				out.WriteString(v.Text)
			}
			at = last
			return nil
		}
		for _, child := range n.Children {
			if e := walk(child); e != nil {
				return e
			}
		}
		return nil
	}
	if e := walk(tree.Declarations[0].Body[0].Children[0]); e != nil {
		return source, e
	}
	out.WriteString(source[at:])
	return out.String(), nil
}
