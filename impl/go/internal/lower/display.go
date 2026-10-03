package lower

import (
	"strconv"
	"strings"
)

// Text's display form has no escapes. Hidden scalars and quotes become source
// expressions, while backslashes remain plain text (chapter 11).
func quote(s string) string {
	var pieces []string
	var plain strings.Builder
	flush := func() {
		if plain.Len() > 0 {
			pieces = append(pieces, `"`+plain.String()+`"`)
			plain.Reset()
		}
	}
	for _, r := range s {
		special := ""
		switch r {
		case '"':
			special = "quote"
		case '\n':
			special = "newline"
		case '\t':
			special = "tab"
		}
		if special == "" && (r < 32 || r >= 127 && r <= 159 || r == 0x61c || r >= 0x200e && r <= 0x200f || r >= 0x2028 && r <= 0x202e || r >= 0x2066 && r <= 0x2069 || r == 0xfeff) {
			special = "fromCodePoint(" + strconv.Itoa(int(r)) + ")"
		}
		if special != "" {
			flush()
			pieces = append(pieces, special)
		} else {
			plain.WriteRune(r)
		}
	}
	flush()
	if len(pieces) == 0 {
		return `""`
	}
	return strings.Join(pieces, " & ")
}
