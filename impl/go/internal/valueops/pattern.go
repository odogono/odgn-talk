package valueops

import (
	"fmt"
	"strconv"
	"strings"

	coreunicode "northtalk.org/go/internal/unicode"
	"northtalk.org/go/internal/value"
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
		root, e := value.ParsePatternTree(v.Text())
		if e != nil {
			return p, e
		}
		var compile func(*value.PatternTree, bool, bool, bool)
		repeat := func(mode string, n *value.PatternTree, f, l bool) {
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
		var numeric func(*value.PatternTree) bool
		numeric = func(n *value.PatternTree) bool {
			if n.Kind == "pattern-convert" || n.Kind == "pattern-typed" {
				return true
			}
			if len(n.Children) > 0 && n.Kind != "text-pattern" {
				return numeric(n.Children[0])
			}
			return false
		}
		compile = func(n *value.PatternTree, f, l, singular bool) {
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
				repeat("optional", &value.PatternTree{Kind: "pattern-text", Text: "-"}, f, l)
				repeat("one or more of", &value.PatternTree{Kind: "pattern-keyword", Text: "digit"}, f, l)
				sequence := &value.PatternTree{Kind: "text-pattern", Children: []*value.PatternTree{{Kind: "pattern-text", Text: "."}, {Kind: "pattern-keyword", Text: "digits"}}}
				repeat("optional", sequence, f, l)
			case "pattern-count":
				count, e := strconv.Atoi(n.Text)
				if e != nil || count > maxProgram {
					compileError = fmt.Errorf("pattern exceeds maximum program size")
					return
				}
				for j := 0; j < count && compileError == nil; j++ {
					if j > 0 && n.Children[0].Kind == "pattern-keyword" && n.Children[0].Text == "words" {
						repeat("one or more of", &value.PatternTree{Kind: "pattern-keyword", Text: "whitespace"}, f, false)
					}
					compile(n.Children[0], f, false, true)
				}
			case "pattern-keyword", "pattern-class":
				k := n.Text
				if k == "word" || k == "words" {
					atom := &value.PatternTree{Kind: "pattern-keyword", Text: "nonspace"}
					repeat("one or more of", atom, f, l)
					if k == "words" && !singular {
						start := emit("split", "", len(p.Code)+1, 0, false)
						repeat("one or more of", &value.PatternTree{Kind: "pattern-keyword", Text: "whitespace"}, f, l)
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
					repeat("zero or more of", &value.PatternTree{Kind: "pattern-keyword", Text: "character"}, f, l)
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
