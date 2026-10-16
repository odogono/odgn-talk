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

// Display walks containers with a heap stack of open containers and their
// next child; a deep transport error must be printable on WASI's bounded
// native stack too, and a long List costs one frame rather than one per item.
func (v Value) Display() string {
	type frame struct {
		value Value
		next  int
	}
	var stack []frame
	var out strings.Builder
	open := func(v Value) {
		switch v.Kind {
		case List:
			out.WriteByte('[')
		case Map:
			out.WriteByte('{')
		case Range:
		case Function:
			f := *v.Function()
			if len(f.Captures) == 0 {
				out.WriteString(v.displayLeaf())
				return
			}
			f.Captures = nil
			fields := v.Fields()
			fields.Function = &f
			out.WriteString(strings.TrimSuffix(fields.Value().displayLeaf(), ">") + " ")
		default:
			out.WriteString(v.displayLeaf())
			return
		}
		stack = append(stack, frame{value: v})
	}
	open(v)
	for len(stack) > 0 {
		top := &stack[len(stack)-1]
		v, i := top.value, top.next
		top.next++
		switch v.Kind {
		case List:
			items := v.Items()
			if i == len(items) {
				out.WriteByte(']')
				break
			}
			if i > 0 {
				out.WriteString(", ")
			}
			open(items[i])
			continue
		case Map:
			pairs := v.Entries()
			if i == len(pairs) {
				out.WriteByte('}')
				break
			}
			if i > 0 {
				out.WriteString(", ")
			}
			key := pairs[i].Key
			// A Word key is bare, except offer, which source reserves as a key (chapter 2).
			if !Word(key) || key == "offer" {
				key = DisplayText(key)
				if !strings.HasPrefix(key, `"`) {
					key = `"" & ` + key
				}
			}
			out.WriteString(key + ": ")
			open(pairs[i].Val)
			continue
		case Range:
			if i < 2 {
				if i == 1 {
					out.WriteString("..")
				}
				open(v.Items()[i])
				continue
			}
		case Function:
			if i == 0 {
				open(Fields{Kind: Map, Entries: v.Function().Captures}.Value())
				continue
			}
			out.WriteByte('>')
		}
		stack = stack[:len(stack)-1]
	}
	return out.String()
}
func (v Value) displayLeaf() string {
	switch v.Kind {
	case Nothing:
		return "nothing"
	case Boolean:
		return strconv.FormatBool(v.Bool)
	case Number:
		return v.Number().String()
	case Quantity:
		return v.Number().String() + " " + v.Unit().Display(v.Number())
	case Text:
		return DisplayText(v.Text())
	case Bytes:
		pieces := make([]string, len(v.Bytes()))
		for i, b := range v.Bytes() {
			pieces[i] = fmt.Sprintf("0x%02X", b)
		}
		return "<<" + strings.Join(pieces, ", ") + ">>"
	case CivilDate:
		return civilText(v.Date())
	case Instant:
		return v.Time().Format(time.RFC3339Nano)
	case Pattern:
		return v.Text()
	case Object:
		return "<object " + v.Object().Kind + " " + DisplayText(v.Object().ID) + ">"
	case Function:
		place := v.Function().Home + ":" + v.Function().Code
		// Named functions retain extension code identity internally, while
		// their display names the Home Script and declaration.
		if v.Function().Name != "" && strings.HasPrefix(v.Function().Code, v.Function().Home+"+") {
			place = v.Function().Home + ":" + v.Function().Name
		}
		// An extension Lambda's Code is unit:line:column. Keep the unit in
		// its identity, but display it without repeating the Home Script.
		if strings.HasPrefix(v.Function().Code, v.Function().Home+"+") && strings.Count(v.Function().Code, ":") == 2 {
			place = v.Function().Code
		}
		s := "<function " + place
		return s + ">"
	}
	panic("unknown value kind")
}
