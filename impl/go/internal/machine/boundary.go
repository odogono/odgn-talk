package machine

import (
	"github.com/odogono/odgn-talk/impl/go/internal/lower"
)

// During's following binding token is a name, not a policy flag.
func DecidingClause(b *lower.Body) bool {
	for j := 0; j < len(b.Checked.Node.Flags); j++ {
		switch b.Checked.Node.Flags[j].Raw {
		case "during":
			j++
		case "deciding":
			return true
		}
	}
	return false
}

func QueuePolicy(b *lower.Body) string {
	for j := 0; j < len(b.Checked.Node.Flags); j++ {
		switch flag := b.Checked.Node.Flags[j].Raw; flag {
		case "during":
			j++
		case "queued", "dropping", "replacing":
			return flag
		}
	}
	return ""
}

// Deferred execution keeps the untouched instruction and operands in plain
// Run state. It is not a Script error, and consumes no instruction charge.
// Supported identifies the standalone execution instructions implemented here.
func Supported(i lower.Instruction) bool {

	switch i.Name {
	case "call-import", "make-imported-function", "ask-wait", "join-ask", "ask", "tell", "const", "pop", "load", "store", "move", "load-var", "store-var", "load-definition", "store-definition", "load-object":
		return true
	case "jump", "branch-false", "branch-true", "check-boolean", "not", "return", "veto", "pass", "call", "call-handler", "call-handler-wait", "call-value-wait", "wait", "wait-for", "wait-for-any", "send", "send-wait", "join-start", "join-send", "join-end":
		return true
	case "add", "subtract", "multiply", "divide", "div", "mod", "power", "negate", "concat", "range":
		return true
	case "equal", "not-equal", "less", "greater", "less-or-equal", "greater-or-equal":
		return true
	case "list", "list-append", "list-extend", "map", "get-key", "get-key-computed", "property", "property-delimited":
		return true
	case "chunk-get", "chunk-get-delimited", "chunk-set", "chunk-set-delimited", "chunk-delete", "chunk-delete-delimited", "test-chunk", "test-chunk-delimited":
		return true
	case "make-pattern", "contains", "begins-with", "ends-with", "matches", "match-all":
		return true
	case "append", "prepend", "append-all", "prepend-all", "iterate", "iterate-times", "next":
		return true
	case "test-map", "test-list", "test-list-at-least", "list-item", "list-rest", "map-get", "test-constant", "test-equal":
		return true
	case "throw", "rethrow", "raise", "end-cleanup", "clause-fail":
		return true
	case "me", "target", "make-function", "make-closure", "call-value", "match-whole", "match-search", "replace-start", "replace-next", "replace-put", "replace-end":
		return true
	case "member", "is-kind", "is-empty", "can-convert", "convert", "test-key", "test-key-computed", "set-key", "set-key-computed", "delete-key", "delete-key-computed":
		return true
	case "bytes-field", "bytes-sized", "bytes-bits", "bin-start", "bin-literal", "bin-int", "bin-bits", "bin-bytes", "bin-rest", "bin-end":
		return true
	case "call-builtin":
		switch i.Operands()[0].Text {
		case "upper", "lower", "floor", "ceiling", "truncate", "round", "sqrt", "exp", "ln", "log10", "power", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "fromFloat64", "fromFloat32", "toFloat64", "toFloat32", "year", "month", "day", "hour", "minute", "second", "nanosecond", "weekday", "dayOfYear", "isoWeek", "isoWeekYear", "hasTime", "toCivil", "toInstant", "fromCodePoint", "codePoint", "offset", "kindOf", "rangeStart", "rangeEnd", "abs", "min", "max", "functionArity", "functionName":
			return true
		}
	}
	return false
}
