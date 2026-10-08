package session

import (
	"fmt"
	"slices"
	"sort"
	"strings"

	talk "github.com/odogono/odgn-talk/impl/go"
	"github.com/odogono/odgn-talk/impl/go/internal/docs"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	coreunicode "github.com/odogono/odgn-talk/impl/go/internal/unicode"
)

// `:describe` and `:apropos` (Session observation, Names and passive describe
// and Name discovery). Both read declaration source and the Built-in catalogue;
// only describing a current Script Variable reads the Group, through one
// explicit vars Host Input.

// target is a canonical describe target, as apropos prints it.
type target struct{ library, name, origin string }

func (t target) String() string {
	if t.origin == "library" {
		return fmt.Sprintf("{library: %s, name: %s, origin: \"library\"}", textDisplay(t.library), textDisplay(t.name))
	}
	return fmt.Sprintf("{name: %s, origin: %s}", textDisplay(t.name), textDisplay(t.origin))
}

// declared is one declaration as describe shows it. Handler Clauses are
// separate, numbered from 1 within their Selector.
type declared struct {
	origin, declaration, signature, doc string
	clause                              int
	// arity is a function's required and total parameter counts.
	arity []int
	// variable names a session Script Variable, whose value needs a snapshot.
	variable string
}

func textDisplay(s string) string {
	v, err := talk.Text(s)
	must(err)
	return v.String()
}

// declaredIn reads a declaration from the source it was parsed from. The
// signature runs from its first token through its grammar head: a function's
// or Handler's head line without a trailing comment, or a Constant's or
// Script Variable's name, without its initializer.
func declaredIn(source string, tree *syntax.Tree, n *syntax.Node, origin string) declared {
	end := n.NameToken.End
	if n.Kind == "function" || n.Kind == "handler" {
		at := sort.Search(len(tree.Tokens), func(i int) bool { return tree.Tokens[i].Start >= n.Token.Start })
		for k := at; k < len(tree.Tokens) && tree.Tokens[k].Kind != syntax.LineBreak; k++ {
			end = tree.Tokens[k].End
		}
	}
	d := declared{origin: origin, declaration: n.Kind, signature: source[n.Token.Start:end], doc: tree.Documentation(n)}
	if n.Kind == "function" {
		required := 0
		for _, p := range n.Params {
			if len(p.Children) == 0 {
				required++
			}
		}
		d.arity = []int{required, len(n.Params)}
	}
	return d
}

// sessionDeclared resolves a current session name or Selector, as binding
// precedence does. An Import resolves to its defining Library declaration.
func (h *Host) sessionDeclared(name string) []declared {
	var out []declared
	for _, d := range h.declarations {
		if d.kind == "use" {
			for _, u := range d.uses {
				if u.local == name {
					return h.libraryDeclared(d.library, u.name)
				}
			}
			continue
		}
		if d.names[0] != name {
			continue
		}
		tree, err := syntax.Parse(d.source)
		if err != nil || len(tree.Declarations) == 0 {
			continue
		}
		m := declaredIn(d.source, tree, tree.Declarations[0], "session")
		if d.kind == "variable" {
			m.variable = name
		}
		if d.kind != "handler" {
			return []declared{m}
		}
		m.clause = len(out) + 1
		out = append(out, m)
	}
	return out
}

func (h *Host) librarySource(library string) (string, bool) {
	if l, added := h.libraries[library]; added {
		return l.compiled.Source(), true
	}
	source, ok := generated.StandardLibraries[library]
	return source, ok
}

// libraryDeclared finds a public Library export from the Library's source,
// whether or not it is imported, without evaluating anything.
func (h *Host) libraryDeclared(library, name string) []declared {
	source, ok := h.librarySource(library)
	if !ok {
		return nil
	}
	tree, err := syntax.Parse(source)
	if err != nil {
		return nil
	}
	var out []declared
	for _, n := range tree.Declarations {
		if n.Private || n.Kind == "use" || n.Text != name {
			continue
		}
		m := declaredIn(source, tree, n, library)
		if n.Kind == "handler" {
			m.clause = len(out) + 1
		}
		out = append(out, m)
	}
	return out
}

// libraryExports lists a Library's public export names in source order.
func (h *Host) libraryExports(library string) []string {
	source, _ := h.librarySource(library)
	tree, err := syntax.Parse(source)
	if err != nil {
		return nil
	}
	var out []string
	for _, n := range tree.Declarations {
		if !n.Private && n.Kind != "use" && !slices.Contains(out, n.Text) {
			out = append(out, n.Text)
		}
	}
	return out
}

func builtinDeclared(name string) []declared {
	for _, b := range generated.Builtins.Builtin {
		if b.Name == name {
			return []declared{{origin: "builtin", declaration: "builtin", signature: b.Call, doc: b.Gives}}
		}
	}
	return nil
}

func docsOf(ds []declared) []Doc {
	var out []Doc
	for _, d := range ds {
		out = append(out, Doc{d.origin, d.declaration, d.clause, d.doc})
	}
	return out
}

// describeTarget reads a plain name or Selector, or a canonical target map.
func describeTarget(rest string) (t target, plain, ok bool) {
	if !strings.HasPrefix(rest, "{") {
		return target{name: rest, origin: "session"}, true, selectorText(rest)
	}
	v, err := readDisplay(rest)
	if err != nil || v.Kind() != talk.KindMap {
		return t, false, false
	}
	fields := map[string]string{}
	for _, p := range v.Entries() {
		s, isText := p.Val.AsText()
		if !isText {
			return t, false, false
		}
		fields[p.Key] = s
	}
	t = target{library: fields["library"], name: fields["name"], origin: fields["origin"]}
	want := 2
	switch t.origin {
	case "library":
		want = 3
		_, ok = fields["library"]
	case "session", "builtin":
		ok = true
	}
	_, named := fields["name"]
	return t, false, ok && named && len(fields) == want
}

func (h *Host) describeCommand(rest string) []string {
	t, plain, ok := describeTarget(rest)
	if !ok {
		return refusal("bad arguments")
	}
	var ds []declared
	switch t.origin {
	case "session":
		ds = h.sessionDeclared(t.name)
		if ds == nil && plain {
			t.origin = "builtin"
			ds = builtinDeclared(t.name)
		}
	case "builtin":
		ds = builtinDeclared(t.name)
	case "library":
		ds = h.libraryDeclared(t.library, t.name)
	}
	if len(ds) == 0 {
		return refusal("no such name")
	}
	var out []string
	for _, d := range ds {
		header := fmt.Sprintf("describe {target: %s, origin: %s, declaration: %s, signature: %s", t, textDisplay(d.origin), textDisplay(d.declaration), textDisplay(d.signature))
		if d.declaration == "handler" {
			header += fmt.Sprintf(", clause: %d", d.clause)
		}
		out = append(out, header+"}", "doc "+textDisplay(d.doc))
		if d.arity != nil {
			out = append(out, fmt.Sprintf("arity %d..%d", d.arity[0], d.arity[1]))
		}
		if d.variable != "" {
			// One explicit snapshot, even when cached state would do.
			for _, p := range h.Inspect().Scripts[0].Vars {
				if p.Key == d.variable {
					rows, _ := docs.Inspection(p.Val)
					out = append(out, rows...)
				}
			}
		}
	}
	return out
}

// found is one apropos target, with every Handler Clause it groups.
type found struct {
	target    target
	origin    string
	available bool
	imports   string
	docs      []declared
}

var originRank = map[string]int{"session": 0, "builtin": 1, "library": 2}

func (h *Host) apropos(rest string) []string {
	query := rest
	if strings.HasPrefix(rest, "\"") {
		v, err := readDisplay(rest)
		s, isText := v.AsText()
		if err != nil || !isText {
			return refusal("bad arguments")
		}
		query = s
	}
	query = foldName(query)
	var all []found
	add := func(f found) {
		if len(f.docs) > 0 && strings.Contains(foldName(f.target.name), query) {
			all = append(all, f)
		}
	}
	var seen []string
	for _, d := range h.declarations {
		for _, name := range d.names {
			if slices.Contains(seen, name) {
				continue
			}
			seen = append(seen, name)
			ds := h.sessionDeclared(name)
			if len(ds) > 0 {
				add(found{target: target{name: name, origin: "session"}, origin: ds[0].origin, available: true, docs: ds})
			}
		}
	}
	for _, b := range generated.Builtins.Builtin {
		add(found{target: target{name: b.Name, origin: "builtin"}, origin: "builtin", available: !h.has(b.Name), docs: builtinDeclared(b.Name)})
	}
	libraries := slices.Sorted(func(yield func(string) bool) {
		for name := range generated.StandardLibraries {
			if !yield(name) {
				return
			}
		}
	})
	libraries = append(libraries, h.libraryOrder...)
	for _, library := range libraries {
		for _, name := range h.libraryExports(library) {
			f := found{target: target{library: library, name: name, origin: "library"}, origin: library, docs: h.libraryDeclared(library, name)}
			f.available = h.imported(library, name)
			if !f.available {
				f.imports = "use " + name + " from " + library
			}
			add(f)
		}
	}
	slices.SortStableFunc(all, func(a, b found) int {
		if c := strings.Compare(a.target.name, b.target.name); c != 0 {
			return c
		}
		if c := originRank[a.target.origin] - originRank[b.target.origin]; c != 0 {
			return c
		}
		return strings.Compare(a.target.library, b.target.library)
	})
	var out []string
	for _, f := range all {
		imports := "nothing"
		if f.imports != "" {
			imports = textDisplay(f.imports)
		}
		out = append(out, fmt.Sprintf("name {target: %s, origin: %s, available: %t, import: %s}", f.target, textDisplay(f.origin), f.available, imports))
		for _, d := range f.docs {
			if d.declaration == "handler" {
				out = append(out, fmt.Sprintf("doc %d %s", d.clause, textDisplay(d.doc)))
			} else {
				out = append(out, "doc "+textDisplay(d.doc))
			}
		}
	}
	return out
}

// imported reports whether a current Import binds the export under its own name.
func (h *Host) imported(library, name string) bool {
	for _, d := range h.declarations {
		if d.kind == "use" && d.library == library && slices.Contains(d.uses, use{name, name}) {
			return true
		}
	}
	return false
}

// foldName is the Built-in lower rule: full default lowercase mapping, then NFC.
func foldName(s string) string {
	out, err := coreunicode.Case(s, false)
	must(err)
	return out
}
