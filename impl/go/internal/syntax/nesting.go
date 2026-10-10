package syntax

// MaxNesting bounds recursive parser regions and syntax-tree depth before
// checking or lowering. Keep native and WASI refusals identical: WASI has a
// much smaller host stack than Go's growable goroutine stack.
const MaxNesting = 64

func nestingError(pos Position) *Error {
	return &Error{Code: "source nesting too deep", Pos: pos}
}

func (p *parser) enter() {
	if p.nesting >= MaxNesting {
		panic(nestingError(p.peek(Operand).Pos))
	}
	p.nesting++
}
func (p *parser) leave() { p.nesting-- }

// Iteratively check every grammar region, including chains the parser builds
// in loops. Those chains would otherwise overflow recursive checker/lowerer
// walks even though parsing itself uses a bounded call stack.
func checkNesting(roots []*Node) {
	type item struct {
		n     *Node
		depth int
	}
	pending := make([]item, 0, len(roots))
	for _, n := range roots {
		pending = append(pending, item{n, 1})
	}
	for len(pending) > 0 {
		next := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if next.n == nil {
			continue
		}
		if next.depth > MaxNesting {
			panic(nestingError(next.n.Pos()))
		}
		for _, region := range [][]*Node{next.n.Children, next.n.Params, next.n.Body, next.n.Branches, {next.n.Guard, next.n.Collect}} {
			for _, child := range region {
				pending = append(pending, item{child, next.depth + 1})
			}
		}
	}
}
