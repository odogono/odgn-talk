package syntax

// MaxNesting bounds recursive parser regions and syntax-tree depth before
// checking or lowering. Keep native and WASI refusals identical: WASI has a
// much smaller host stack than Go's growable goroutine stack.
const MaxNesting = 64

func nestingError(pos Position) *Error {
	return &Error{Code: "source nesting too deep", Pos: pos}
}
