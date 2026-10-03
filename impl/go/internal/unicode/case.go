package unicode

import (
	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"unicode/utf8"
)

// Case applies pinned full default mappings and the context-sensitive final
// sigma rule, then normalizes to NFC. Locale-specific rules do not apply.
func Case(s string, upper bool) (string, error) {
	if !utf8.ValidString(s) {
		return "", errInvalidUTF8
	}
	rs := []rune(s)
	out := make([]rune, 0, len(rs))
	table := generated.Lowercase
	if upper {
		table = generated.Uppercase
	}
	for i, cp := range rs {
		if !upper && cp == 0x03a3 {
			before, after := false, false
			for j := i - 1; j >= 0; j-- {
				if property(generated.CaseIgnorable, rs[j]) != 0 {
					continue
				}
				before = property(generated.Cased, rs[j]) != 0
				break
			}
			for j := i + 1; j < len(rs); j++ {
				if property(generated.CaseIgnorable, rs[j]) != 0 {
					continue
				}
				after = property(generated.Cased, rs[j]) != 0
				break
			}
			if before && !after {
				out = append(out, 0x03c2)
				continue
			}
		}
		if mapped, ok := table[cp]; ok {
			out = append(out, mapped...)
		} else {
			out = append(out, cp)
		}
	}
	return NFC(string(out))
}
