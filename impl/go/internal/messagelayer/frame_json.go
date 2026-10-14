package messagelayer

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"unicode/utf8"
)

// frameJSON retains spans of the original JSON. Containers are parsed on a
// heap stack, and RawMessage fields copy their spans rather than passing
// through encoding/json's 10,000-level scanner. Scalar syntax and conversion
// still use encoding/json; arbitrary precision number tokens stay raw.
type frameJSON struct {
	start    int
	raw      []byte
	kind     byte
	children []int
	keys     []string
}
type frameReader struct {
	data  []byte
	at    int
	nodes []frameJSON
}
type frameContainer struct {
	node  int
	state frameState
}

// frameState is where a container's reader stands between its delimiters.
type frameState byte

const (
	frameOpened     frameState = iota // after the opening delimiter
	frameNextChild                    // after a comma
	frameAfterChild                   // after a complete child
)

func (r *frameReader) space() {
	for r.at < len(r.data) && bytes.IndexByte([]byte(" \t\r\n"), r.data[r.at]) >= 0 {
		r.at++
	}
}
func (r *frameReader) bad() error { return fmt.Errorf("invalid JSON at byte %d", r.at) }
func (r *frameReader) quoted() (string, error) {
	start := r.at
	if r.at >= len(r.data) || r.data[r.at] != '"' {
		return "", r.bad()
	}
	r.at++
	for r.at < len(r.data) {
		c := r.data[r.at]
		r.at++
		if c == '\\' {
			if r.at < len(r.data) {
				r.at++
			}
			continue
		}
		if c == '"' {
			var text string
			err := json.Unmarshal(r.data[start:r.at], &text)
			return text, err
		}
	}
	return "", r.bad()
}
func (r *frameReader) start() (int, bool, error) {
	r.space()
	if r.at >= len(r.data) {
		return 0, false, r.bad()
	}
	start := r.at
	c := r.data[r.at]
	container := c == '[' || c == '{'
	if container {
		r.at++
	} else if c == '"' {
		if _, err := r.quoted(); err != nil {
			return 0, false, err
		}
	} else {
		for r.at < len(r.data) && bytes.IndexByte([]byte(" \t\r\n,]}"), r.data[r.at]) < 0 {
			r.at++
		}
		raw := r.data[start:r.at]
		if !bytes.Equal(raw, []byte("true")) && !bytes.Equal(raw, []byte("false")) && !bytes.Equal(raw, []byte("null")) {
			var number json.Number
			if len(raw) == 0 {
				return 0, false, r.bad()
			}
			if err := json.Unmarshal(raw, &number); err != nil {
				return 0, false, err
			}
		}
	}
	i := len(r.nodes)
	r.nodes = append(r.nodes, frameJSON{start: start, raw: r.data[start:r.at], kind: c})
	return i, container, nil
}
func parseFrameJSON(data []byte) ([]frameJSON, error) {
	if !utf8.Valid(data) {
		return nil, fmt.Errorf("invalid UTF-8 JSON")
	}
	r := frameReader{data: data}
	root, container, err := r.start()
	if err != nil {
		return nil, err
	}
	var stack []frameContainer
	if container {
		stack = append(stack, frameContainer{node: root})
	}
	for len(stack) > 0 {
		r.space()
		if r.at >= len(data) {
			return nil, r.bad()
		}
		top := &stack[len(stack)-1]
		node := &r.nodes[top.node]
		closing := byte(']')
		if node.kind == '{' {
			closing = '}'
		}
		if top.state == frameAfterChild {
			if data[r.at] != closing {
				if data[r.at] != ',' {
					return nil, r.bad()
				}
				r.at++
				top.state = frameNextChild
				continue
			}
		} else if data[r.at] != closing || top.state == frameNextChild {
			if node.kind == '{' {
				key, err := r.quoted()
				if err != nil {
					return nil, err
				}
				node.keys = append(node.keys, key)
				r.space()
				if r.at >= len(data) || data[r.at] != ':' {
					return nil, r.bad()
				}
				r.at++
			}
			parent := top.node
			top.state = frameAfterChild
			child, container, err := r.start()
			if err != nil {
				return nil, err
			}
			r.nodes[parent].children = append(r.nodes[parent].children, child)
			if container {
				stack = append(stack, frameContainer{node: child})
			}
			continue
		}
		r.at++
		node.raw = data[node.start:r.at]
		stack = stack[:len(stack)-1]
	}
	r.space()
	if r.at != len(data) {
		return nil, r.bad()
	}
	return r.nodes, nil
}

var rawMessageType = reflect.TypeFor[json.RawMessage]()

// The target types are the layer's finite declaration/envelope structures.
// Their RawMessage leaves stop conversion before any Value nesting is walked.
func unmarshalFrame(data []byte, into any) error {
	nodes, err := parseFrameJSON(data)
	if err != nil {
		return err
	}
	dst := reflect.ValueOf(into)
	if dst.Kind() != reflect.Pointer || dst.IsNil() {
		return fmt.Errorf("JSON target must be a pointer")
	}
	return decodeFrameNode(nodes, 0, dst.Elem())
}
func decodeFrameNode(nodes []frameJSON, i int, dst reflect.Value) error {
	n := nodes[i]
	if dst.Type() == rawMessageType {
		dst.SetBytes(bytes.Clone(n.raw))
		return nil
	}
	if bytes.Equal(n.raw, []byte("null")) {
		return json.Unmarshal(n.raw, dst.Addr().Interface())
	}
	if dst.Kind() == reflect.Pointer {
		if dst.IsNil() {
			dst.Set(reflect.New(dst.Type().Elem()))
		}
		return decodeFrameNode(nodes, i, dst.Elem())
	}
	switch dst.Kind() {
	case reflect.Struct:
		if n.kind != '{' {
			break
		}
		typ := dst.Type()
		for j, key := range n.keys {
			for field := 0; field < typ.NumField(); field++ {
				f := typ.Field(field)
				if f.PkgPath != "" {
					continue
				}
				name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
				if name == "-" {
					continue
				}
				if name == "" {
					name = f.Name
				}
				if strings.EqualFold(key, name) {
					if err := decodeFrameNode(nodes, n.children[j], dst.Field(field)); err != nil {
						return err
					}
					break
				}
			}
		}
		return nil
	case reflect.Map:
		if n.kind != '{' || dst.Type().Key().Kind() != reflect.String {
			break
		}
		if dst.IsNil() {
			dst.Set(reflect.MakeMap(dst.Type()))
		}
		for j, key := range n.keys {
			item := reflect.New(dst.Type().Elem()).Elem()
			if err := decodeFrameNode(nodes, n.children[j], item); err != nil {
				return err
			}
			k := reflect.New(dst.Type().Key()).Elem()
			k.SetString(key)
			dst.SetMapIndex(k, item)
		}
		return nil
	case reflect.Slice:
		if n.kind != '[' {
			break
		}
		dst.Set(reflect.MakeSlice(dst.Type(), len(n.children), len(n.children)))
		for j, child := range n.children {
			if err := decodeFrameNode(nodes, child, dst.Index(j)); err != nil {
				return err
			}
		}
		return nil
	}
	return json.Unmarshal(n.raw, dst.Addr().Interface())
}
