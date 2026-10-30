package syntax

import (
	"slices"

	"northtalk.org/go/internal/generated"
)

func isName(t Token) bool {
	return t.Kind == Word && t.Raw != "_" && !slices.Contains(generated.Grammar.Reserved, t.Raw)
}

// Argument Labels are data-driven and read after a complete argument or pattern.
func isLabel(t Token) bool {
	return t.Kind == Word && (isName(t) || slices.Contains(generated.Grammar.Labels.Reserved, t.Raw)) && !slices.Contains(generated.Grammar.Labels.Excluded, t.Raw)
}
