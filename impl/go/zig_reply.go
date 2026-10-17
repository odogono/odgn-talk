//go:build talk_zig_experimental

package northtalk

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"unicode/utf8"
)

// zigReply is one JSON value of a guest frame, kept as its raw bytes; nil is
// absent. A frame is validated once, on a heap stack (ADR 0088), and its
// envelope is then read in place. Each Value Encoding payload is decoded
// once, from its own bytes, by decodeValue.
type zigReply []byte

// zigParseReply validates one guest frame and returns its root value.
func zigParseReply(data []byte) (zigReply, error) {
	if !utf8.Valid(data) {
		return nil, fmt.Errorf("invalid UTF-8 JSON")
	}
	start := zigSpace(data, 0)
	end, err := zigValidate(data, start)
	if err != nil {
		return nil, err
	}
	if zigSpace(data, end) != len(data) {
		return nil, fmt.Errorf("invalid JSON at byte %d", end)
	}
	return zigReply(data[start:end]), nil
}

// zigPacket is a reply's envelope, read in one pass over its members.
type zigPacket struct {
	root                                          zigReply
	ref, ok, err, need, abandoned, settled, trace zigReply
}

var zigPacketKeys = []string{"ref", "ok", "err", "need", "abandoned", "settled", "trace"}

func zigReadPacket(root zigReply) zigPacket {
	var f [7]zigReply
	root.lookup(zigPacketKeys, f[:])
	return zigPacket{root, f[0], f[1], f[2], f[3], f[4], f[5], f[6]}
}

func zigSpace(d []byte, i int) int {
	for i < len(d) && (d[i] == ' ' || d[i] == '\t' || d[i] == '\r' || d[i] == '\n') {
		i++
	}
	return i
}

// zigValidate checks the JSON value at d[i:] and returns its end. Containers
// are tracked on a heap stack, so depth is bounded only by memory.
func zigValidate(d []byte, i int) (int, error) {
	var stack []byte
	bad := func() (int, error) { return 0, fmt.Errorf("invalid JSON at byte %d", i) }
	key := func() bool {
		i = zigSpace(d, i)
		end, ok := zigValidString(d, i)
		if !ok {
			return false
		}
		i = zigSpace(d, end)
		if i >= len(d) || d[i] != ':' {
			return false
		}
		i++
		return true
	}
	for {
		i = zigSpace(d, i)
		if i >= len(d) {
			return bad()
		}
		switch c := d[i]; c {
		case '{', '[':
			closing := byte('}')
			if c == '[' {
				closing = ']'
			}
			i = zigSpace(d, i+1)
			if i < len(d) && d[i] == closing {
				i++
				break
			}
			stack = append(stack, c)
			if c == '{' && !key() {
				return bad()
			}
			continue
		case '"':
			end, ok := zigValidString(d, i)
			if !ok {
				return bad()
			}
			i = end
		case 't', 'f', 'n':
			lit := "null"
			if c == 't' {
				lit = "true"
			} else if c == 'f' {
				lit = "false"
			}
			if !bytes.HasPrefix(d[i:], []byte(lit)) {
				return bad()
			}
			i += len(lit)
		default:
			end, ok := zigValidNumber(d, i)
			if !ok {
				return bad()
			}
			i = end
		}
		for {
			if len(stack) == 0 {
				return i, nil
			}
			i = zigSpace(d, i)
			if i >= len(d) {
				return bad()
			}
			top := stack[len(stack)-1]
			if d[i] == ',' {
				i++
				if top == '{' && !key() {
					return bad()
				}
				break
			}
			if top == '{' && d[i] == '}' || top == '[' && d[i] == ']' {
				i++
				stack = stack[:len(stack)-1]
				continue
			}
			return bad()
		}
	}
}

func zigValidString(d []byte, i int) (int, bool) {
	if i >= len(d) || d[i] != '"' {
		return 0, false
	}
	for i++; i < len(d); i++ {
		switch c := d[i]; {
		case c == '"':
			return i + 1, true
		case c < 0x20:
			return 0, false
		case c == '\\':
			i++
			if i >= len(d) {
				return 0, false
			}
			switch d[i] {
			case '"', '\\', '/', 'b', 'f', 'n', 'r', 't':
			case 'u':
				if i+4 >= len(d) {
					return 0, false
				}
				for _, h := range d[i+1 : i+5] {
					if !(h >= '0' && h <= '9' || h >= 'a' && h <= 'f' || h >= 'A' && h <= 'F') {
						return 0, false
					}
				}
				i += 4
			default:
				return 0, false
			}
		}
	}
	return 0, false
}

func zigValidNumber(d []byte, i int) (int, bool) {
	digits := func() bool {
		start := i
		for i < len(d) && d[i] >= '0' && d[i] <= '9' {
			i++
		}
		return i > start
	}
	if i < len(d) && d[i] == '-' {
		i++
	}
	if i < len(d) && d[i] == '0' {
		i++
	} else if !digits() {
		return 0, false
	}
	if i < len(d) && d[i] == '.' {
		i++
		if !digits() {
			return 0, false
		}
	}
	if i < len(d) && (d[i] == 'e' || d[i] == 'E') {
		i++
		if i < len(d) && (d[i] == '+' || d[i] == '-') {
			i++
		}
		if !digits() {
			return 0, false
		}
	}
	return i, true
}

// zigSkip returns the end of the already-validated value at d[i:].
func zigSkip(d []byte, i int) int {
	depth := 0
	for ; i < len(d); i++ {
		switch d[i] {
		case '"':
			for i++; d[i] != '"'; i++ {
				if d[i] == '\\' {
					i++
				}
			}
			if depth == 0 {
				return i + 1
			}
		case '{', '[':
			depth++
		case '}', ']':
			if depth == 0 {
				return i
			}
			depth--
			if depth == 0 {
				return i + 1
			}
		case ',', ' ', '\t', '\r', '\n':
			if depth == 0 {
				return i
			}
		}
	}
	return i
}

// members calls yield with each raw key and value of an object, until it
// returns false.
func (r zigReply) members(yield func(key []byte, val zigReply) bool) {
	if len(r) == 0 || r[0] != '{' {
		return
	}
	i := 1
	for {
		i = zigSpace(r, i)
		if i >= len(r) || r[i] != '"' {
			return
		}
		keyEnd := zigSkip(r, i)
		key := r[i+1 : keyEnd-1]
		i = zigSpace(r, keyEnd) + 1
		i = zigSpace(r, i)
		end := zigSkip(r, i)
		if !yield(key, r[i:end:end]) {
			return
		}
		i = zigSpace(r, end)
		if i >= len(r) || r[i] != ',' {
			return
		}
		i++
	}
}

func zigKeyIs(raw []byte, key string) bool {
	if bytes.IndexByte(raw, '\\') < 0 {
		return string(raw) == key
	}
	return zigUnquote(raw) == key
}

// get is the member named key, or nil.
func (r zigReply) get(key string) zigReply {
	var found zigReply
	r.members(func(k []byte, v zigReply) bool {
		if zigKeyIs(k, key) {
			found = v
			return false
		}
		return true
	})
	return found
}

// lookup fills out[i] with the first member named keys[i], in one pass.
func (r zigReply) lookup(keys []string, out []zigReply) {
	r.members(func(k []byte, v zigReply) bool {
		for i, key := range keys {
			if out[i] == nil && zigKeyIs(k, key) {
				out[i] = v
			}
		}
		return true
	})
}

type zigMember struct {
	Key string
	Val zigReply
}

func (r zigReply) entries() []zigMember {
	var out []zigMember
	r.members(func(k []byte, v zigReply) bool {
		key := string(k)
		if bytes.IndexByte(k, '\\') >= 0 {
			key = zigUnquote(k)
		}
		out = append(out, zigMember{key, v})
		return true
	})
	return out
}

// items are an array's elements; anything else has none.
func (r zigReply) items() []zigReply {
	if len(r) == 0 || r[0] != '[' {
		return nil
	}
	var out []zigReply
	for i := zigSpace(r, 1); i < len(r) && r[i] != ']'; {
		end := zigSkip(r, i)
		out = append(out, r[i:end:end])
		i = zigSpace(r, end)
		if i < len(r) && r[i] == ',' {
			i = zigSpace(r, i+1)
		}
	}
	return out
}

func (r zigReply) present() bool { return len(r) != 0 && string(r) != "null" }
func (r zigReply) isMap() bool   { return len(r) != 0 && r[0] == '{' }
func (r zigReply) isList() bool  { return len(r) != 0 && r[0] == '[' }

func (r zigReply) text() (string, bool) {
	if len(r) < 2 || r[0] != '"' {
		return "", false
	}
	inner := r[1 : len(r)-1]
	if bytes.IndexByte(inner, '\\') < 0 {
		return string(inner), true
	}
	return zigUnquote(inner), true
}

func (r zigReply) boolean() (bool, bool) {
	switch string(r) {
	case "true":
		return true, true
	case "false":
		return false, true
	}
	return false, false
}

func (r zigReply) int64() (int64, bool) {
	n, err := strconv.ParseInt(string(r), 10, 64)
	return n, err == nil
}

// zigUnquote decodes a validated string body that holds escapes.
func zigUnquote(inner []byte) string {
	var s string
	quoted := make([]byte, 0, len(inner)+2)
	quoted = append(append(append(quoted, '"'), inner...), '"')
	_ = json.Unmarshal(quoted, &s)
	return s
}

func zigText(r zigReply) string { s, _ := r.text(); return s }

// zigTextPair reads a two-text array, such as a [kind, id] Object reference.
func zigTextPair(r zigReply) (string, string) {
	items := r.items()
	if len(items) != 2 {
		return "", ""
	}
	return zigText(items[0]), zigText(items[1])
}
