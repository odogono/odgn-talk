package syntax

import "strings"

// ValidMessageSelector checks chapter 9's contract for colon-containing names.
// Ordinary message names retain the Host boundary's existing rules.
func ValidMessageSelector(message string, arity int) bool {
	if !strings.Contains(message, ":") {
		return true
	}
	parts := strings.Split(message, ":")
	if len(parts) < 3 || parts[len(parts)-1] != "" || len(parts)-1 != arity {
		return false
	}
	for i, part := range parts[:len(parts)-1] {
		lx, err := NewLexer(part)
		if err != nil {
			return false
		}
		token, err := lx.Next(Operand)
		if err != nil || token.Raw != part || token.Leading != "" {
			return false
		}
		if i == 0 {
			if !isName(token) || part == "all" {
				return false
			}
		} else if !isLabel(token) {
			return false
		}
	}
	return true
}

// ValidComputedMessageName checks chapter 5's rule for a `send`'s computed
// name: a Name a static `send` could write, or a Selector with one argument
// per part (ADR 0057).
func ValidComputedMessageName(message string, arity int) bool {
	if strings.Contains(message, ":") {
		return ValidMessageSelector(message, arity)
	}
	lx, err := NewLexer(message)
	if err != nil {
		return false
	}
	token, err := lx.Next(Operand)
	return err == nil && token.Raw == message && token.Leading == "" && isName(token) && message != "all"
}
