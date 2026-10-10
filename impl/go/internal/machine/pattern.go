package machine

import (
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	coreunicode "github.com/odogono/odgn-talk/impl/go/internal/unicode"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

type patternInstruction struct {
	Op, Text string
	A, B     int
	Fold     bool
}
type patternProgram struct {
	Code    []patternInstruction
	Names   []string
	Numeric []bool
}

func compilePattern(v value.Value, fold bool) (patternProgram, error) {
	p := patternProgram{}
	if v.Kind != value.Text && v.Kind != value.Pattern {
		return p, fmt.Errorf("expected text or pattern")
	}
	var compileError error
	const maxProgram = 100000
	emit := func(op, s string, a, b int, f bool) int {
		j := len(p.Code)
		p.Code = append(p.Code, patternInstruction{op, s, a, b, f})
		return j
	}
	literal := func(s string, f bool) {
		bs, _ := coreunicode.Boundaries(s)
		for j := 0; j < len(bs)-1; j++ {
			emit("char", s[bs[j]:bs[j+1]], 0, 0, f)
		}
	}
	if v.Kind == value.Text {
		literal(v.Text(), fold)
	} else {
		tree, e := syntax.Parse("on pattern\n put " + v.Text() + " into result\nend pattern\n")
		if e != nil {
			return p, e
		}
		root := tree.Declarations[0].Body[0].Children[0]
		var compile func(*syntax.Node, bool, bool, bool)
		repeat := func(mode string, n *syntax.Node, f, l bool) {
			start := len(p.Code)
			split := -1
			if mode != "one or more of" {
				split = emit("split", "", start+1, 0, false)
			}
			compile(n, f, false, false)
			if mode == "one or more of" {
				split = emit("split", "", start, len(p.Code)+1, false)
			} else if mode == "zero or more of" {
				emit("jump", "", start, 0, false)
			}
			if mode != "one or more of" {
				p.Code[split].B = len(p.Code)
			}
			if l {
				p.Code[split].A, p.Code[split].B = p.Code[split].B, p.Code[split].A
			}
		}
		var numeric func(*syntax.Node) bool
		numeric = func(n *syntax.Node) bool {
			if n.Kind == "pattern-convert" || n.Kind == "pattern-typed" {
				return true
			}
			if len(n.Children) > 0 && n.Kind != "text-pattern" {
				return numeric(n.Children[0])
			}
			return false
		}
		compile = func(n *syntax.Node, f, l, singular bool) {
			if compileError != nil {
				return
			}
			if len(p.Code) > maxProgram {
				compileError = fmt.Errorf("pattern exceeds maximum program size")
				return
			}
			switch n.Kind {
			case "text-pattern":
				for _, child := range n.Children {
					compile(child, f, false, false)
				}
			case "pattern-text":
				literal(n.Text, f)
			case "splice":
				source := tree.Source()
				raw := strings.TrimSpace(source[n.Token.End:n.End.Start])
				v, e := constant(raw)
				if e != nil {
					panic(e)
				}
				literal(v.Text(), f)
			case "pattern-fold":
				compile(n.Children[0], true, l, singular)
			case "pattern-lazy":
				compile(n.Children[0], f, true, singular)
			case "pattern-convert":
				compile(n.Children[0], f, l, singular)
			case "capture":
				j := len(p.Names)
				p.Names = append(p.Names, n.Text)
				p.Numeric = append(p.Numeric, numeric(n.Children[0]))
				emit("save", "", 2*j, 0, false)
				compile(n.Children[0], f, l, false)
				emit("save", "", 2*j+1, 0, false)
			case "pattern-anchor":
				emit("assert", n.Text, 0, 0, false)
			case "pattern-or":
				split := emit("split", "", len(p.Code)+1, 0, false)
				compile(n.Children[0], f, false, false)
				jump := emit("jump", "", 0, 0, false)
				p.Code[split].B = len(p.Code)
				compile(n.Children[1], f, false, false)
				p.Code[jump].A = len(p.Code)
			case "pattern-repeat":
				repeat(n.Text, n.Children[0], f, l)
			case "pattern-typed":
				repeat("optional", &syntax.Node{Kind: "pattern-text", Text: "-"}, f, l)
				repeat("one or more of", &syntax.Node{Kind: "pattern-keyword", Text: "digit"}, f, l)
				sequence := &syntax.Node{Kind: "text-pattern", Children: []*syntax.Node{{Kind: "pattern-text", Text: "."}, {Kind: "pattern-keyword", Text: "digits"}}}
				repeat("optional", sequence, f, l)
			case "pattern-count":
				count, e := strconv.Atoi(n.Text)
				if e != nil || count > maxProgram {
					compileError = fmt.Errorf("pattern exceeds maximum program size")
					return
				}
				for j := 0; j < count && compileError == nil; j++ {
					if j > 0 && n.Children[0].Kind == "pattern-keyword" && n.Children[0].Text == "words" {
						repeat("one or more of", &syntax.Node{Kind: "pattern-keyword", Text: "whitespace"}, f, false)
					}
					compile(n.Children[0], f, false, true)
				}
			case "pattern-keyword", "pattern-class":
				k := n.Text
				if k == "word" || k == "words" {
					atom := &syntax.Node{Kind: "pattern-keyword", Text: "nonspace"}
					repeat("one or more of", atom, f, l)
					if k == "words" && !singular {
						start := emit("split", "", len(p.Code)+1, 0, false)
						repeat("one or more of", &syntax.Node{Kind: "pattern-keyword", Text: "whitespace"}, f, l)
						repeat("one or more of", atom, f, l)
						emit("jump", "", start, 0, false)
						p.Code[start].B = len(p.Code)
						if l {
							p.Code[start].A, p.Code[start].B = p.Code[start].B, p.Code[start].A
						}
					}
					break
				}
				if k == "text" {
					repeat("zero or more of", &syntax.Node{Kind: "pattern-keyword", Text: "character"}, f, l)
					break
				}
				plural := strings.HasSuffix(k, "s")
				if plural {
					k = strings.TrimSuffix(k, "s")
				}
				if plural && !singular {
					copy := *n
					copy.Text = k
					repeat("one or more of", &copy, f, l)
					break
				}
				switch k {
				case "space":
					literal(" ", f)
				case "character":
					emit("class", "any", 0, 0, false)
				case "uppercase letter":
					emit("class", "uppercase", 0, 0, false)
				case "lowercase letter":
					emit("class", "lowercase", 0, 0, false)
				default:
					emit("class", k, 0, 0, false)
				}
			default:
				panic("unimplemented pattern node " + n.Kind)
			}
		}
		compile(root, fold, false, false)
		if compileError != nil {
			return p, compileError
		}
	}
	emit("match", "", 0, 0, false)
	if len(p.Code) > maxProgram {
		return p, fmt.Errorf("pattern exceeds maximum program size")
	}
	return p, nil
}
func patternSize(s string) int {
	p, e := compilePattern(value.Fields{Kind: value.Pattern, Text: s}.Value(), false)
	if e != nil {
		return 100001
	}
	return len(p.Code)
}
func category(cp rune) string {
	j := sort.Search(len(generated.Category), func(j int) bool { return generated.Category[j].End >= cp })
	if j < len(generated.Category) && generated.Category[j].Start <= cp {
		return generated.Category[j].Value
	}
	return ""
}
func acceptsClass(k, s string) bool {
	cp, _ := utf8.DecodeRuneInString(s)
	switch k {
	case "any":
		return true
	case "digit":
		return len(s) == 1 && cp >= '0' && cp <= '9'
	case "letter":
		return strings.HasPrefix(category(cp), "L")
	case "uppercase":
		return category(cp) == "Lu"
	case "lowercase":
		return category(cp) == "Ll"
	case "punctuation":
		return strings.HasPrefix(category(cp), "P")
	case "whitespace":
		return coreunicode.WhiteSpace(cp)
	case "nonspace":
		return !coreunicode.WhiteSpace(cp)
	}
	return false
}

type thread struct {
	PC, Start int
	Captures  []int
}
type patternMatch struct {
	Start, End int
	Captures   []int
}

func search(p patternProgram, s string, start int, mode string, first bool) (*patternMatch, int64) {
	bounds, _ := coreunicode.Boundaries(s)
	n := len(bounds) - 1
	chars := make([]string, n)
	for j := range chars {
		chars[j] = s[bounds[j]:bounds[j+1]]
	}
	return searchCharacters(p, chars, start, mode, first)
}
func searchCharacters(p patternProgram, chars []string, start int, mode string, first bool) (*patternMatch, int64) {
	n := len(chars)
	nonspace := func(j int) bool { return j >= 0 && j < n && acceptsClass("nonspace", chars[j]) }
	lineBreak := func(j int) bool {
		return j >= 0 && j < n && (chars[j] == "\r" || chars[j] == "\n" || chars[j] == "\r\n")
	}
	anchor := func(k string, pos int) bool {
		switch k {
		case "text start":
			return pos == 0
		case "text end":
			return pos == n
		case "word break":
			return nonspace(pos-1) != nonspace(pos)
		case "line start":
			return pos == 0 || lineBreak(pos-1)
		case "line end":
			return pos == n || lineBreak(pos)
		}
		return false
	}
	var add func(*[]thread, map[int]bool, thread, int)
	add = func(list *[]thread, marks map[int]bool, t thread, pos int) {
		if marks[t.PC] {
			return
		}
		marks[t.PC] = true
		i := p.Code[t.PC]
		switch i.Op {
		case "jump":
			t.PC = i.A
			add(list, marks, t, pos)
		case "split":
			a, b := t, t
			a.PC = i.A
			b.PC = i.B
			add(list, marks, a, pos)
			add(list, marks, b, pos)
		case "save":
			t.Captures = slices.Clone(t.Captures)
			t.Captures[i.A] = pos
			t.PC++
			add(list, marks, t, pos)
		case "assert":
			if anchor(i.Text, pos) {
				t.PC++
				add(list, marks, t, pos)
			}
		default:
			*list = append(*list, t)
		}
	}
	var list []thread
	marks := map[int]bool{}
	var match *patternMatch
	var steps int64
	for pos := start; pos <= n; pos++ {
		seed := match == nil && ((mode == "search" || mode == "suffix") || pos == start)
		if seed {
			caps := make([]int, len(p.Names)*2)
			for j := range caps {
				caps[j] = -1
			}
			add(&list, marks, thread{Start: pos, Captures: caps}, pos)
		}
		steps += int64(len(list))
		next := []thread{}
		nextMarks := map[int]bool{}
		for _, t := range list {
			i := p.Code[t.PC]
			if i.Op == "match" {
				if mode != "whole" && mode != "suffix" || pos == n {
					match = &patternMatch{t.Start, pos, t.Captures}
					if first {
						return match, steps
					}
					break
				}
			} else if pos < n {
				ok := false
				if i.Op == "class" {
					ok = acceptsClass(i.Text, chars[pos])
				} else if i.Op == "char" {
					a, b := i.Text, chars[pos]
					if i.Fold {
						a, _ = coreunicode.Fold(a)
						b, _ = coreunicode.Fold(b)
					}
					ok = a == b
				}
				if ok {
					t.PC++
					add(&next, nextMarks, t, pos+1)
				}
			}
		}
		list, marks = next, nextMarks
		if len(list) == 0 && (match != nil || mode == "whole" || mode == "prefix") {
			break
		}
	}
	return match, steps
}
func matchValue(p patternProgram, s string, m *patternMatch) (value.Value, *value.Value) {
	bounds, _ := coreunicode.Boundaries(s)
	rangeOf := func(a, b int) value.Value { v, _ := value.NewRange(integer(int64(a+1)), integer(int64(b))); return v }
	var captures, ranges []value.Pair
	for j, name := range p.Names {
		v, w := value.Value{}, value.Value{}
		a, b := m.Captures[2*j], m.Captures[2*j+1]
		if a >= 0 && b >= 0 {
			v = text(s[bounds[a]:bounds[b]])
			if p.Numeric[j] {
				n, e := decimal.Parse(v.Text())
				if e != nil {
					err := failure("can't convert", value.Pair{Key: "value", Val: v}, value.Pair{Key: "to", Val: text("number")})
					return value.Value{}, &err
				}
				v = value.Fields{Kind: value.Number, Number: n}.Value()
			}
			w = rangeOf(a, b)
		}
		captures = append(captures, value.Pair{Key: name, Val: v})
		ranges = append(ranges, value.Pair{Key: name, Val: w})
	}
	c, _ := value.NewMap(captures)
	rs, _ := value.NewMap(ranges)
	v, _ := value.NewMap([]value.Pair{{Key: "text", Val: text(s[bounds[m.Start]:bounds[m.End]])}, {Key: "range", Val: rangeOf(m.Start, m.End)}, {Key: "captures", Val: c}, {Key: "ranges", Val: rs}})
	return v, nil
}
func allMatches(p patternProgram, s string) (value.Value, int64, *value.Value) {
	bounds, _ := coreunicode.Boundaries(s)
	last := -1
	start := 0
	var vs []value.Value
	var steps int64
	for start < len(bounds) {
		m, cost := search(p, s, start, "search", false)
		steps += cost
		if m == nil {
			break
		}
		if m.Start == m.End && m.Start == last {
			start = m.End + 1
			continue
		}
		v, e := matchValue(p, s, m)
		if e != nil {
			return value.Value{}, steps, e
		}
		vs = append(vs, v)
		last = m.End
		start = m.End
	}
	return value.NewList(vs), steps, nil
}
