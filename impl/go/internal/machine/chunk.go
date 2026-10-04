package machine

import (
	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"math/big"
	"slices"
	"strings"
	"unicode/utf8"

	coreunicode "github.com/odogono/odgn-talk/impl/go/internal/unicode"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

func spans(kind, s, d string) [][2]int {
	var out [][2]int
	switch kind {
	case "character":
		bs, _ := coreunicode.Boundaries(s)
		for j := 0; j < len(bs)-1; j++ {
			out = append(out, [2]int{bs[j], bs[j+1]})
		}
	case "code point":
		for at, cp := range s {
			out = append(out, [2]int{at, at + utf8.RuneLen(cp)})
		}
	case "word":
		ws, _ := coreunicode.Words(s)
		for _, w := range ws {
			out = append(out, [2]int{w.Start, w.End})
		}
	case "line", "item":
		bs, _ := coreunicode.Boundaries(s)
		boundary := map[int]bool{}
		for _, b := range bs {
			boundary[b] = true
		}
		start := 0
		for at := 0; at < len(s); {
			width := 0
			if kind == "line" {
				switch s[at] {
				case '\r':
					width = 1
					if strings.HasPrefix(s[at:], "\r\n") {
						width = 2
					}
				case '\n':
					width = 1
				}
			} else if strings.HasPrefix(s[at:], d) && boundary[at] && boundary[at+len(d)] {
				width = len(d)
			}
			if width > 0 {
				out = append(out, [2]int{start, at})
				at += width
				start = at
			} else {
				_, n := utf8.DecodeRuneInString(s[at:])
				at += n
			}
		}
		if start < len(s) {
			out = append(out, [2]int{start, len(s)})
		}
	}
	return out
}
func indices(index value.Value, count int) (int64, int64, *value.Value) {
	one := func(v value.Value) (int64, *value.Value) {
		if v.Kind != value.Number {
			e := wrong("number", v)
			return 0, &e
		}
		n, ok := v.Number.Integer()
		if !ok {
			e := wrong("integer", v)
			return 0, &e
		}
		var i int64
		if !n.IsInt64() {
			if n.Sign() > 0 {
				i = 1 << 60
			} else {
				i = -(1 << 60)
			}
		} else {
			i = n.Int64()
		}
		if i < 0 {
			i = int64(count) + i + 1
		}
		return i, nil
	}
	if index.Kind == value.Range {
		a, e := one(index.Items[0])
		if e != nil {
			return 0, 0, e
		}
		b, e := one(index.Items[1])
		return a, b, e
	}
	a, e := one(index)
	return a, a, e
}
func chunk(op, kind string, index, whole, part, delimiter value.Value) (value.Value, int64, bool, *value.Value) {
	fail := func(v value.Value) (value.Value, int64, bool, *value.Value) { return value.Value{}, 0, false, &v }
	if delimiter.Kind != value.Text {
		return fail(wrong("text", delimiter))
	}
	if delimiter.Text == "" {
		return fail(failure("out of range", value.Pair{Key: "field", Val: text("delimiter")}, value.Pair{Key: "value", Val: delimiter}))
	}
	var chunks [][2]int
	count := 0
	if whole.Kind == value.Range {
		return rangeChunk(op, kind, index, whole)
	}
	if whole.Kind == value.Text && kind != "byte" {
		chunks = spans(kind, whole.Text, delimiter.Text)
		count = len(chunks)
	} else if kind == "item" && whole.Kind == value.List {
		count = len(whole.Items)
	} else if kind == "byte" && whole.Kind == value.Bytes {
		count = len(whole.Bytes)
	} else {
		return fail(wrong("text", whole))
	}
	a, b, e := indices(index, count)
	if e != nil {
		return value.Value{}, 0, false, e
	}
	exists := a >= 1 && b <= int64(count) && a <= b
	read := strings.HasPrefix(op, "chunk-get") || strings.HasPrefix(op, "test-chunk")
	if read {
		lo, hi := max(1, a), min(int64(count), b)
		empty := lo > hi
		scanned := int64(count)
		if whole.Kind == value.Text {
			scanned = measure("characters", whole)
			if kind == "code point" {
				scanned = measure("scalars", whole)
			}
			if !empty {
				end := chunks[hi-1][1]
				if kind == "code point" {
					scanned = int64(utf8.RuneCountInString(whole.Text[:end]))
				} else {
					scanned = measure("characters", text(whole.Text[:end]))
				}
			}
			if empty {
				return text(""), scanned, exists, nil
			}
			return text(whole.Text[chunks[lo-1][0]:chunks[hi-1][1]]), scanned, exists, nil
		}
		if !empty {
			scanned = hi
		}
		if whole.Kind == value.List {
			if index.Kind == value.Range {
				if empty {
					return value.NewList(nil), scanned, exists, nil
				}
				return value.NewList(whole.Items[lo-1 : hi]), scanned, exists, nil
			}
			if !exists {
				return value.Value{}, scanned, false, nil
			}
			return whole.Items[a-1], scanned, true, nil
		}
		if index.Kind == value.Range {
			if empty {
				return value.NewBytes(nil), scanned, exists, nil
			}
			return value.NewBytes(whole.Bytes[lo-1 : hi]), scanned, exists, nil
		}
		if !exists {
			return value.Value{}, scanned, false, nil
		}
		return integer(int64(whole.Bytes[a-1])), scanned, true, nil
	}
	deleting := strings.HasPrefix(op, "chunk-delete")
	if deleting && !exists {
		return whole, int64(count), false, nil
	}
	pad := whole.Kind == value.List || whole.Kind == value.Text && (kind == "item" || kind == "line")
	if a < 1 || a > b || (!pad && b > int64(count)) {
		v := index
		if index.Kind == value.Range {
			v = value.NewList(index.Items)
		}
		return fail(failure("out of range", value.Pair{Key: "field", Val: text(kind)}, value.Pair{Key: "value", Val: v}))
	}
	if whole.Kind == value.Text {
		s := whole.Text
		d := delimiter.Text
		if kind == "line" {
			d = "\n"
		}
		if pad && b > int64(count) {
			// Everything beyond the range's end is empty. Build only the
			// prefix retained before its start, never the discarded tail.
			if a <= int64(count) {
				return text(s[:chunks[a-1][0]] + textForm(part)), 0, true, nil
			}
			padding := a - int64(count) - 1
			if count == 0 || chunks[count-1][1] == len(s) {
				padding++
			}
			if count == 0 {
				padding = a - 1
			}
			s += strings.Repeat(d, int(padding))
			return text(s + textForm(part)), 0, true, nil
		}
		start, end := chunks[a-1][0], chunks[b-1][1]
		if deleting {
			if kind == "word" {
				if b < int64(count) {
					end = chunks[b][0]
				} else if a > 1 {
					start = chunks[a-2][1]
				}
			} else if kind == "item" || kind == "line" {
				if b < int64(count) {
					end = chunks[b][0]
				} else if a > 1 {
					start = chunks[a-2][1]
				}
			}
			return text(s[:start] + s[end:]), 0, true, nil
		}
		return text(s[:start] + textForm(part) + s[end:]), 0, true, nil
	}
	if whole.Kind == value.List {
		vs := slices.Clone(whole.Items)
		if !deleting && b > int64(len(vs)) {
			vs = append(vs, make([]value.Value, max(0, int(a)-1-len(vs)))...)
			b = int64(len(vs))
		}
		var replacement []value.Value
		if !deleting {
			if index.Kind == value.Range {
				if part.Kind != value.List {
					return fail(wrong("list", part))
				}
				replacement = part.Items
			} else {
				replacement = []value.Value{part}
			}
		}
		out := append(slices.Clone(vs[:a-1]), replacement...)
		out = append(out, vs[b:]...)
		return value.NewList(out), 0, true, nil
	}
	if whole.Kind == value.Bytes {
		var replacement []byte
		if !deleting {
			if index.Kind == value.Range {
				if part.Kind != value.Bytes {
					return fail(wrong("bytes", part))
				}
				replacement = part.Bytes
			} else {
				n, e := binaryInteger(part, 8, false, "byte")
				if e != nil {
					return value.Value{}, 0, false, e
				}
				replacement = n.Bytes()
				if len(replacement) == 0 {
					replacement = []byte{0}
				}
			}
		}
		out := append(slices.Clone(whole.Bytes[:a-1]), replacement...)
		out = append(out, whole.Bytes[b:]...)
		return value.NewBytes(out), 0, true, nil
	}
	return fail(wrong("text", whole))
}
func property(name string, v, d value.Value) (value.Value, *value.Value) {
	bad := func(expected string) (value.Value, *value.Value) { e := wrong(expected, v); return value.Value{}, &e }
	switch name {
	case "length":
		if integerRange(v) {
			a, _ := v.Items[0].Number.Integer()
			b, _ := v.Items[1].Number.Integer()
			n := new(big.Int).Sub(b, a)
			n.Add(n, big.NewInt(1))
			if n.Sign() < 0 {
				n.SetInt64(0)
			}
			number, e := decimal.Round(new(big.Rat).SetInt(n), 0, "length")
			if e != nil {
				err := failure("overflow", value.Pair{Key: "operator", Val: text("length")})
				return value.Value{}, &err
			}
			return value.Value{Kind: value.Number, Number: number}, nil
		}
		switch v.Kind {
		case value.Text:
			return integer(measure("characters", v)), nil
		case value.Bytes:
			return integer(int64(len(v.Bytes))), nil
		case value.List:
			return integer(int64(len(v.Items))), nil
		case value.Map:
			return integer(int64(len(v.Entries))), nil
		}
		return bad("text, bytes, list or map")
	case "bytes":
		if v.Kind != value.Bytes {
			return bad("bytes")
		}
		vs := make([]value.Value, len(v.Bytes))
		for j, b := range v.Bytes {
			vs[j] = integer(int64(b))
		}
		return value.NewList(vs), nil
	case "keys", "values":
		if v.Kind != value.Map {
			return bad("map")
		}
		var vs []value.Value
		for _, p := range v.Entries {
			if name == "keys" {
				vs = append(vs, text(p.Key))
			} else {
				vs = append(vs, p.Val)
			}
		}
		return value.NewList(vs), nil
	case "characters", "words", "lines", "items", "code points":
		if d.Kind != value.Text {
			e := wrong("text", d)
			return value.Value{}, &e
		}
		if d.Text == "" {
			e := failure("out of range", value.Pair{Key: "field", Val: text("delimiter")}, value.Pair{Key: "value", Val: d})
			return value.Value{}, &e
		}
		if name == "items" && integerRange(v) {
			result, _ := rangeList(v, 1, measure("items", v))
			return result, nil
		}
		if v.Kind != value.Text {
			return bad("text")
		}
		kind := strings.TrimSuffix(name, "s")
		var vs []value.Value
		for _, s := range spans(kind, v.Text, d.Text) {
			vs = append(vs, text(v.Text[s[0]:s[1]]))
		}
		return value.NewList(vs), nil
	}
	return bad("value")
}
func appendValue(whole, part value.Value, prepend, all bool) (value.Value, *value.Value) {
	if whole.Kind == value.Text {
		if prepend {
			return text(textForm(part) + whole.Text), nil
		}
		return text(whole.Text + textForm(part)), nil
	}
	if whole.Kind == value.List {
		vs := []value.Value{part}
		if all {
			if part.Kind != value.List {
				e := wrong("list", part)
				return value.Value{}, &e
			}
			vs = part.Items
		}
		if prepend {
			return value.NewList(append(slices.Clone(vs), whole.Items...)), nil
		}
		return value.NewList(append(slices.Clone(whole.Items), vs...)), nil
	}
	e := wrong("text", whole)
	return value.Value{}, &e
}
