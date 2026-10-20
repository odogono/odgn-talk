//go:build !talk_native_go

package northtalk

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"time"
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

// zigJSONPacket is the reader's private JSON envelope, read in one pass.
type zigJSONPacket struct {
	root                                          zigReply
	ref, ok, err, need, abandoned, settled, trace zigReply
}

var zigJSONPacketKeys = []string{"ref", "ok", "err", "need", "abandoned", "settled", "trace"}

func zigReadPacket(root zigReply) zigJSONPacket {
	var f [7]zigReply
	root.lookup(zigJSONPacketKeys, f[:])
	return zigJSONPacket{root: root, ref: f[0], ok: f[1], err: f[2], need: f[3], abandoned: f[4], settled: f[5], trace: f[6]}
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

// The envelope is read in place from the reply's bytes. Data payloads are
// decoded once, straight from their own bytes, as Value Encodings, preserving
// tags and decimals.
func zigDecode(src zigReply, dst reflect.Value) error { return zigDecodeResolving(src, dst, nil) }

// zigField identifies one destination field in an envelope struct.
type zigField struct {
	index     int
	name      string
	anonymous bool
}

type zigStructFields struct {
	fields []zigField
	keys   []string
}

var zigFieldCache sync.Map // reflect.Type -> zigStructFields

func zigFields(t reflect.Type) zigStructFields {
	if cached, ok := zigFieldCache.Load(t); ok {
		return cached.(zigStructFields)
	}
	var fields zigStructFields
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if f.Name == "Reports" {
			continue
		}
		key := strings.ToLower(f.Name[:1]) + f.Name[1:]
		if f.Name == "ID" || f.Name == "PC" {
			key = strings.ToLower(f.Name)
		}
		if f.Name == "Function" {
			key = "fn"
		}
		fields.fields = append(fields.fields, zigField{i, f.Name, f.Anonymous})
		if f.Anonymous {
			// Embedded fields read the enclosing object themselves.
			key = ""
		}
		fields.keys = append(fields.keys, key)
	}
	zigFieldCache.Store(t, fields)
	return fields
}

var (
	zigObjectType      = reflect.TypeFor[*Object]()
	zigValueType       = reflect.TypeFor[Value]()
	zigPairType        = reflect.TypeFor[Pair]()
	zigTimeType        = reflect.TypeFor[time.Time]()
	zigScriptErrorType = reflect.TypeFor[ScriptError]()
)

func zigDecodeResolving(src zigReply, dst reflect.Value, b zigValueResolver) error {
	if !src.present() {
		return nil
	}
	switch dst.Type() {
	case zigObjectType:
		ref := src.get("$object").items()
		o, ok := (*Object)(nil), false
		if b != nil && len(ref) == 2 {
			o, ok = b.resolve(zigText(ref[0]), zigText(ref[1]))
		}
		if !ok {
			return fmt.Errorf("Zig named an unknown Object")
		}
		dst.Set(reflect.ValueOf(o))
		return nil
	case zigValueType:
		v, err := zigDecodeValue(src, b)
		if err != nil {
			return err
		}
		dst.Set(reflect.ValueOf(v))
		return nil
	case zigPairType:
		items := src.items()
		if len(items) != 2 {
			return fmt.Errorf("invalid Zig variable pair")
		}
		dst.FieldByName("Key").SetString(zigText(items[0]))
		return zigDecodeResolving(items[1], dst.FieldByName("Val"), b)
	case zigTimeType:
		t, err := time.Parse(time.RFC3339Nano, zigText(src))
		if err != nil {
			return err
		}
		dst.Set(reflect.ValueOf(t))
		return nil
	case zigScriptErrorType:
		var data []Pair
		for _, pair := range src.entries() {
			switch pair.Key {
			case "code":
				dst.FieldByName("Code").SetString(zigText(pair.Val))
			case "message":
				dst.FieldByName("Message").SetString(zigText(pair.Val))
			default:
				var v Value
				if err := zigDecodeResolving(pair.Val, reflect.ValueOf(&v).Elem(), b); err != nil {
					return err
				}
				data = append(data, KV(pair.Key, v))
			}
		}
		v, err := Map(data...)
		if err != nil {
			return err
		}
		dst.FieldByName("Data").Set(reflect.ValueOf(v))
		return nil
	}
	if values, ok := zigEnums[dst.Type()]; ok {
		return zigEnumText(zigText(src), dst, values)
	}
	switch dst.Kind() {
	case reflect.Pointer:
		dst.Set(reflect.New(dst.Type().Elem()))
		return zigDecodeResolving(src, dst.Elem(), b)
	case reflect.Struct:
		if !src.isMap() {
			return fmt.Errorf("invalid Zig %s", dst.Type())
		}
		fields := zigFields(dst.Type())
		// Most envelopes fit on the stack. Read spans in one pass without
		// allocating a member list or copying every key, including unknown ones.
		var local [16]zigReply
		values := local[:]
		if len(fields.fields) > len(values) {
			values = make([]zigReply, len(fields.fields))
		}
		values = values[:len(fields.fields)]
		src.lookup(fields.keys, values)
		for i, f := range fields.fields {
			if f.anonymous {
				if err := zigDecodeResolving(src, dst.Field(f.index), b); err != nil {
					return err
				}
				continue
			}
			if err := zigDecodeResolving(values[i], dst.Field(f.index), b); err != nil {
				return fmt.Errorf("%s: %w", f.name, err)
			}
		}
	case reflect.Slice:
		if !src.isList() {
			return fmt.Errorf("expected Zig array for %s", dst.Type())
		}
		items := src.items()
		dst.Set(reflect.MakeSlice(dst.Type(), len(items), len(items)))
		for i, item := range items {
			if err := zigDecodeResolving(item, dst.Index(i), b); err != nil {
				return err
			}
		}
	case reflect.String:
		v, ok := src.text()
		if !ok {
			return fmt.Errorf("expected Zig text")
		}
		dst.SetString(v)
	case reflect.Bool:
		v, ok := src.boolean()
		if !ok {
			return fmt.Errorf("expected Zig boolean")
		}
		dst.SetBool(v)
	case reflect.Int, reflect.Int64:
		v, ok := src.int64()
		if !ok {
			return fmt.Errorf("expected Zig integer")
		}
		if dst.OverflowInt(v) {
			return fmt.Errorf("Zig integer overflow")
		}
		dst.SetInt(v)
	default:
		return fmt.Errorf("unsupported Zig field type %s", dst.Type())
	}
	return nil
}

var zigGroupStates = map[string]int{"idle": int(Idle), "sliced": int(Sliced), "stopped": int(Stopped), "rewound": int(Rewound)}

// zigEnums are the envelope enums the guest writes as text.
var zigEnums = map[reflect.Type]map[string]int{
	reflect.TypeFor[GroupState](): zigGroupStates,
	reflect.TypeFor[Outcome]():    {"completed": int(Completed), "errored": int(Errored), "limit fault": int(LimitFault), "cancelled": int(Cancelled), "unhandled": int(UnhandledOutcome), "dropped": int(Dropped), "effect failed": int(EffectFailureOutcome)},
	reflect.TypeFor[Verdict]():    {"allowed": int(Allowed), "vetoed": int(Vetoed), "undecided": int(Undecided)},
	reflect.TypeFor[RunStatus]():  {"ready": int(Ready), "suspended": int(Suspended), "parked": int(Parked), "preempted": int(Preempted)},
}

func zigEnumText(text string, dst reflect.Value, values map[string]int) error {
	v, ok := values[text]
	if !ok {
		return fmt.Errorf("unknown Zig %s %q", dst.Type(), text)
	}
	dst.SetInt(int64(v))
	return nil
}

// decodePumpHeader keeps JSON reflection's destination on its own path; the
// binary completion header needs no reflective staging allocation.
func (r zigReplyReader) decodePumpHeader(body zigReply) (PumpResult, error) {
	var result PumpResult
	err := zigDecodeResolving(body, reflect.ValueOf(&result).Elem(), r.resolver)
	return result, err
}

func zigFailure(failure zigReply) error {
	switch zigText(failure.get("kind")) {
	case "host error":
		return &HostError{Code: HostErrorCode(zigText(failure.get("code"))), Detail: zigText(failure.get("detail"))}
	case "mailbox full":
		return ErrMailboxFull
	case "load error":
		rejected := new(LoadError)
		if err := zigDecode(failure, reflect.ValueOf(rejected).Elem()); err != nil {
			return err
		}
		return rejected
	default:
		return fmt.Errorf("Zig Message Layer: %s", zigText(failure.get("detail")))
	}
}
