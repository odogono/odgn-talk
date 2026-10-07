package check

import "github.com/odogono/odgn-talk/impl/go/internal/syntax"

// Resolve transitive calls before checking restricted regions. Lambda bodies
// are independent: creating a suspending Lambda does not suspend its creator.
func (u *Unit) checkRestrictedSuspension() {
	reaches := map[string]bool{}
	for _, b := range u.Bodies {
		if b.Kind == "handler" || b.Kind == "function" {
			reaches[b.Name] = reaches[b.Name] || b.MaySuspend
		}
	}
	suspends := func(b *Body, n *syntax.Node) bool {
		s, ok := u.Resolve(b, n.Text)
		return ok && (s.Kind == "handler" || s.Kind == "function") && (s.MaySuspend || s.Import == "" && reaches[s.Name])
	}
	for changed := true; changed; {
		changed = false
		for _, b := range u.Bodies {
			if b.Kind != "function" || reaches[b.Name] {
				continue
			}
			syntax.Walk(b.Node, func(n *syntax.Node) bool {
				if n != b.Node && n.Kind == "lambda" {
					return false
				}
				if (n.Kind == "call" || n.Kind == "command" && syntax.HasFlag(n, "and")) && suspends(b, n) {
					reaches[b.Name] = true
					changed = true
				}
				return true
			})
		}
	}
	for _, b := range u.Bodies {
		if u.inheritedBody(b) {
			continue
		}
		type site struct {
			node       *syntax.Node
			restricted bool
		}
		work := []site{{b.Node, false}}
		for len(work) > 0 {
			current := work[len(work)-1]
			work = work[:len(work)-1]
			n, restricted := current.node, current.restricted
			if n != b.Node && n.Kind == "lambda" {
				continue
			}
			restricted = restricted || n.Kind == "finally"
			if (restricted && (n.Kind == "call" || n.Kind == "command") || b.Kind == "function" && n.Kind == "call") && suspends(b, n) {
				u.add("can't suspend here", n.Pos())
			}
			// Recovery restricts the body, while the pattern and Guard keep
			// their ordinary rules. No source ordering is needed here.
			for _, group := range [][]*syntax.Node{n.Params, n.Children, n.Branches} {
				for _, child := range group {
					work = append(work, site{child, restricted})
				}
			}
			bodyRestricted := restricted || n.Kind == "catch" && syntax.HasFlag(n, "before")
			for _, child := range n.Body {
				work = append(work, site{child, bodyRestricted})
			}
			if n.Guard != nil {
				work = append(work, site{n.Guard, restricted})
			}
			if n.Collect != nil {
				work = append(work, site{n.Collect, restricted})
			}
		}
	}
}
