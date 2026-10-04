package check

import (
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/shape"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

type OperationCheck struct {
	Mode string
	Args []shape.Shape
}

func (u *Unit) checkOperations() {
	if u.Options.Grants == nil {
		return
	}
	for _, decl := range u.Tree.Declarations {
		syntax.Walk(decl, func(n *syntax.Node) bool {
			say := n.Kind == "command" && n.Text == "say"
			if !say && n.Kind != "ask" && n.Kind != "tell" {
				return true
			}
			grant, op := "console", "write"
			grantPos, opPos := n.Pos(), n.Pos()
			if !say {
				grant = n.Params[0].Text
				op = n.Text
				grantPos = n.Params[0].FirstPos()
				opPos = n.NameToken.Pos
			}
			ops, ok := u.Options.Grants[grant]
			if !ok {
				u.add("unknown operation", grantPos)
				return true
			}
			d, ok := ops[op]
			if !ok {
				u.add("unknown operation", opPos)
				return true
			}
			mode := "fire-and-forget"
			if n.Kind == "ask" {
				mode = "immediate"
				if syntax.HasFlag(n, "and") {
					mode = "suspending"
				}
			}
			if d.Mode != mode {
				u.add("wrong mode", n.Pos())
				return true
			}
			if say && len(n.Children) != 1 || !shape.Accepts(d.Args, len(n.Children)) {
				u.add("wrong argument count", opPos)
				return true
			}
			for i, arg := range n.Children {
				if !literalFits(arg, d.Args[i]) {
					u.add("wrong argument", arg.FirstPos())
				}
			}
			return true
		})
	}
}

// Only the outer literal kind and a map literal's keys are known at load.
// Nested contents and computed expressions are checked at the Host crossing.
func literalFits(n *syntax.Node, s shape.Shape) bool {
	kind, unit := "", ""
	switch n.Kind {
	case "list":
		kind = "list"
	case "map":
		kind = "map"
	case "text-pattern":
		kind = "pattern"
	case "literal":
		if n.Text == "it" || n.Text == "me" {
			return true
		}
		switch n.Token.Kind {
		case syntax.Text:
			kind = "text"
		case syntax.Number:
			kind = "number"
			if len(n.Params) > 0 {
				kind = "quantity"
				u, e := value.ParseUnit(n.Params[0].Text)
				if e != nil {
					return true
				}
				unit = u.String()
			}
		default:
			switch n.Text {
			case "true", "false":
				kind = "boolean"
			case "nothing":
				kind = "nothing"
			default:
				return true
			}
		}
	default:
		return true
	}
	switch s.Kind {
	case "any", "value":
		return true
	case "kind":
		return kind == s.Name
	case "optional":
		return kind == "nothing" || literalFits(n, s.Of[0])
	case "oneOf":
		for _, x := range s.Of {
			if literalFits(n, x) {
				return true
			}
		}
		return false
	case "quantity":
		return kind == "quantity" && unit == s.Name
	case "unitKind":
		if kind != "quantity" {
			return false
		}
		u, _ := value.ParseUnit(unit)
		return len(u.Slots) == 1 && u.Slots[0].Power.String() == "1" && generated.Units.Unit[u.Slots[0].Unit].Kind == s.Name
	case "list":
		return kind == "list"
	case "map":
		if kind != "map" {
			return false
		}
		keys := map[string]bool{}
		for _, e := range n.Children {
			keys[e.Text] = true
		}
		declared := map[string]bool{}
		for _, f := range s.Fields {
			declared[f.Key] = true
			if !f.Optional && !keys[f.Key] {
				return false
			}
		}
		if !s.Open {
			for key := range keys {
				if !declared[key] {
					return false
				}
			}
		}
		return true
	default:
		return false
	}
}
