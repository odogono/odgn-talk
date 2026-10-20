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
		token, ok := oneToken(part)
		if !ok {
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

// IsLabel reports whether word is one Argument Label word, as an Operation
// Declaration's labels must be (ADR 0115).
func IsLabel(word string) bool {
	token, ok := oneToken(word)
	return ok && isLabel(token)
}

// oneToken lexes text that must be exactly one operand token.
func oneToken(text string) (Token, bool) {
	lx, err := NewLexer(text)
	if err != nil {
		return Token{}, false
	}
	token, err := lx.Next(Operand)
	return token, err == nil && token.Raw == text && token.Leading == ""
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
