package value

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

func hidden(cp rune) bool {
	return cp < 0x20 || cp >= 0x7f && cp <= 0x9f || cp == 0x61c || cp == 0x200e || cp == 0x200f || cp >= 0x2028 && cp <= 0x202e || cp >= 0x2066 && cp <= 0x2069 || cp == 0xfeff
}
func DisplayText(s string) string {
	var pieces []string
	var plain strings.Builder
	flush := func() {
		if plain.Len() > 0 {
			pieces = append(pieces, `"`+plain.String()+`"`)
			plain.Reset()
		}
	}
	for _, cp := range s {
		if cp == '"' || hidden(cp) {
			flush()
			switch cp {
			case '"':
				pieces = append(pieces, "quote")
			case '\n':
				pieces = append(pieces, "newline")
			case '\t':
				pieces = append(pieces, "tab")
			default:
				pieces = append(pieces, "fromCodePoint("+strconv.Itoa(int(cp))+")")
			}
		} else {
			plain.WriteRune(cp)
		}
	}
	flush()
	if len(pieces) == 0 {
		return `""`
	}
	return strings.Join(pieces, " & ")
}
func Word(s string) bool {
	if s == "" {
		return false
	}
	for i, c := range s {
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c == '_' || i > 0 && c >= '0' && c <= '9' {
			continue
		}
		return false
	}
	return true
}
func (v Value) Display() string {
	switch v.Kind {
	case Nothing:
		return "nothing"
	case Boolean:
		return strconv.FormatBool(v.Bool)
	case Number:
		return v.Number.String()
	case Quantity:
		return v.Number.String() + " " + v.Unit.Display(v.Number)
	case Text:
		return DisplayText(v.Text)
	case Bytes:
		pieces := make([]string, len(v.Bytes))
		for i, b := range v.Bytes {
			pieces[i] = fmt.Sprintf("0x%02X", b)
		}
		return "<<" + strings.Join(pieces, ", ") + ">>"
	case List:
		pieces := make([]string, len(v.Items))
		for i, item := range v.Items {
			pieces[i] = item.Display()
		}
		return "[" + strings.Join(pieces, ", ") + "]"
	case Range:
		return v.Items[0].Display() + ".." + v.Items[1].Display()
	case Map:
		pieces := make([]string, len(v.Entries))
		for i, p := range v.Entries {
			key := p.Key
			if !Word(key) {
				key = DisplayText(key)
				if !strings.HasPrefix(key, `"`) {
					key = `"" & ` + key
				}
			}
			pieces[i] = key + ": " + p.Val.Display()
		}
		return "{" + strings.Join(pieces, ", ") + "}"
	case CivilDate:
		return civilText(v.Date)
	case Instant:
		return time.Unix(v.Seconds, int64(v.Nanos)).UTC().Format(time.RFC3339Nano)
	case Pattern:
		return v.Text
	case Object:
		return "<object " + v.Object.Kind + " " + DisplayText(v.Object.ID) + ">"
	case Function:
		place := v.Function.Home + ":" + v.Function.Code
		// An extension Lambda's Code is unit:line:column. Keep the unit in
		// its identity, but display it without repeating the Home Script.
		if strings.HasPrefix(v.Function.Code, v.Function.Home+"+") && strings.Count(v.Function.Code, ":") == 2 {
			place = v.Function.Code
		}
		s := "<function " + place
		if len(v.Function.Captures) > 0 {
			s += " " + (Value{Kind: Map, Entries: v.Function.Captures}).Display()
		}
		return s + ">"
	}
	panic("unknown value kind")
}
