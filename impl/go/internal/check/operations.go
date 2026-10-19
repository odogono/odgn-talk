package check

import (
	"fmt"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/shape"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
	"slices"
)

type OperationCheck struct {
	Mode string
	Args []shape.Shape
	// Command also makes the Operation a Host Command (ADR 0094).
	Command bool `json:",omitempty"`
}

// OperationUse keeps the original call for rechecking it against an importing
// Script's Grant declarations. Identity distinguishes shared diamond imports.
type OperationUse struct {
	Unit     string
	Identity [32]byte
	Call     *syntax.Node
}

func OperationUses(tree *syntax.Tree, unit string) []OperationUse {
	var uses []OperationUse
	for _, decl := range tree.Declarations {
		syntax.Walk(decl, func(n *syntax.Node) bool {
			if n.Kind == "ask" || n.Kind == "tell" || n.Kind == "command" && n.Text == "say" {
				uses = append(uses, OperationUse{Unit: unit, Call: n})
			}
			return true
		})
	}
	slices.SortStableFunc(uses, func(a, b OperationUse) int {
		if a.Call.Pos().Line != b.Call.Pos().Line {
			return a.Call.Pos().Line - b.Call.Pos().Line
		}
		return a.Call.Pos().Column - b.Call.Pos().Column
	})
	return uses
}

func OperationNames(n *syntax.Node) (string, string) {
	if n.Kind == "command" {
		return "console", "write"
	}
	return n.Params[0].Text, n.Text
}

func (u *Unit) checkOperations() {
	if u.Options.Grants == nil {
		return
	}
	u.lowerHostCommands()
	ResolveLines(u.Tree, u.Options.Grants)
	reported := map[syntax.Position]bool{}
	for _, site := range OperationUses(u.Tree, "") {
		n := site.Call
		report := u.add
		if syntax.HasFlag(n, "line") {
			// A Grant the Script doesn't hold is reported once, at the
			// block's receiver.
			report = func(code string, pos syntax.Position) {
				if !reported[pos] {
					reported[pos] = true
					u.add(code, pos)
				}
			}
		}
		checkOperation(n, u.Options.Grants, report)
	}
	if u.Options.Library {
		return
	}
	for _, n := range u.Tree.Declarations {
		if n.Kind != "use" {
			continue
		}
		missing := map[[2]string]bool{}
		for _, site := range u.Options.ImportCalls[n.Text] {
			grant, op := OperationNames(site.Call)
			report := func(code string, _ syntax.Position) {
				pos := site.Call.Pos()
				message := fmt.Sprintf("%s: %s.%s at %s:%d:%d", code, grant, op, site.Unit, pos.Line, pos.Column)
				u.Diagnostics = append(u.Diagnostics, Diagnostic{Code: code, Pos: n.Pos(), Message: message})
			}
			if _, ok := u.Options.Grants[grant][op]; !ok {
				key := [2]string{grant, op}
				if !missing[key] {
					report("missing grant", n.Pos())
					missing[key] = true
				}
			} else {
				checkOperation(site.Call, u.Options.Grants, report)
			}
		}
	}
}

// resolveHostCommands finds each unlabelled Command Call that names no
// Handler of the unit, local, imported or from an earlier Extend, and that
// exactly one Grant offers as an Operation declared `command` (ADR 0094). A
// labelled call's Selector is never a single word, so it never matches. A
// call two Grants offer is a `name clash` at the call, and so is an Import
// named like a Host Command, at its name in the `use` line. It runs after the
// declarations are collected and before validation, so a Library's Host
// Commands aren't `not in a library`, while the call stays a Command Call
// for the Join and Timeout Block checks.
func (u *Unit) resolveHostCommands() {
	offered := map[string][]string{}
	for grant, ops := range u.Options.Grants {
		for op, d := range ops {
			if d.Command {
				offered[op] = append(offered[op], grant)
			}
		}
	}
	if len(offered) == 0 {
		return
	}
	u.hostCommands = map[*syntax.Node]string{}
	for _, decl := range u.Tree.Declarations {
		if decl.Kind == "use" {
			library, ok := u.Options.Imports[decl.Text]
			if !ok {
				continue
			}
			for _, param := range decl.Params {
				if _, ok := library[param.Text]; !ok {
					continue
				}
				local := param
				if len(decl.Children) > 0 {
					local = decl.Children[0]
				}
				if offered[local.Text] != nil {
					u.add("name clash", local.Pos())
				}
			}
			continue
		}
		syntax.Walk(decl, func(n *syntax.Node) bool {
			if n.Kind != "command" || n.Text == "say" {
				return true
			}
			if _, ok := u.Handlers[n.Text]; ok {
				return true
			}
			switch grants := offered[n.Text]; len(grants) {
			case 0:
			case 1:
				u.hostCommands[n] = grants[0]
			default:
				u.add("name clash", n.Pos())
			}
			return true
		})
	}
}

// lowerHostCommands makes each resolved Host Command the one-line call it
// stands for: a `tell` when its Operation is fire-and-forget and it has no
// `and wait`, and otherwise an `ask` (ADR 0094). It then checks, lowers and
// counts as that call, for `needs`, GrantsAsUsed and an importer's recheck,
// whose result never changes it.
func (u *Unit) lowerHostCommands() {
	for n, grant := range u.hostCommands {
		name := n.Token
		n.NameToken = &name
		n.Params = []*syntax.Node{{Kind: "name", Text: grant, Token: syntax.Token{Kind: syntax.Word, Raw: grant, Pos: n.Token.Pos}}}
		n.Kind = "ask"
		if u.Options.Grants[grant][n.Text].Mode == "fire-and-forget" && !syntax.HasFlag(n, "and") {
			n.Kind = "tell"
		}
	}
	u.hostCommands = nil
}

// ResolveLines makes each `tell` block line whose Operation is
// fire-and-forget, and which has no `and wait`, a `tell` (ADR 0063). Every
// other line stays an `ask`. It runs once, against the Grants the unit is
// compiled with, so an importer's recheck never changes a Library's lines.
func ResolveLines(tree *syntax.Tree, grants map[string]map[string]OperationCheck) {
	for _, site := range OperationUses(tree, "") {
		n := site.Call
		if !syntax.HasFlag(n, "line") || syntax.HasFlag(n, "and") {
			continue
		}
		if d, ok := grants[n.Params[0].Text][n.Text]; ok && d.Mode == "fire-and-forget" {
			n.Kind = "tell"
		}
	}
}

// Direct and imported calls use the same mode, arity and literal Shape rules.
func checkOperation(n *syntax.Node, grants map[string]map[string]OperationCheck, report func(string, syntax.Position)) {
	say := n.Kind == "command"
	grant, op := OperationNames(n)
	grantPos, opPos := n.Pos(), n.Pos()
	if !say {
		grantPos = n.Params[0].FirstPos()
		opPos = n.NameToken.Pos
	}
	ops, ok := grants[grant]
	if !ok {
		report("unknown operation", grantPos)
		return
	}
	d, ok := ops[op]
	if !ok {
		report("unknown operation", opPos)
		return
	}
	mode := "fire-and-forget"
	if n.Kind == "ask" {
		mode = "immediate"
		if syntax.HasFlag(n, "and") {
			mode = "suspending"
		}
	}
	if d.Mode != mode || n.Target != nil && mode == "fire-and-forget" {
		report("wrong mode", n.Pos())
		return
	}
	if say && len(n.Children) != 1 || !shape.Accepts(d.Args, len(n.Children)) {
		report("wrong argument count", opPos)
		return
	}
	for i, arg := range n.Children {
		if !literalFits(arg, d.Args[i]) {
			report("wrong argument", arg.FirstPos())
		}
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
