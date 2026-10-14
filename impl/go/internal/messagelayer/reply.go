package messagelayer

import (
	"encoding/json"
	"sort"
)

// marshalReply assembles the layer's shallow maps and lists around Values
// already written by the Core's Value Encoding writer. encoding/json would
// validate RawMessage again and reject an otherwise valid deep Value at
// 10,000 levels. Only trusted, Core-encoded Values enter replies as RawMessage;
// incoming frames still pass the transport's JSON checks.
func marshalReply(v any) ([]byte, error) {
	return appendReply(nil, v)
}

func appendReply(out []byte, v any) ([]byte, error) {
	switch v := v.(type) {
	case json.RawMessage:
		if v == nil {
			return append(out, "null"...), nil
		}
		return append(out, v...), nil
	case map[string]any:
		if v == nil {
			return append(out, "null"...), nil
		}
		keys := make([]string, 0, len(v))
		for key := range v {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		out = append(out, '{')
		for i, key := range keys {
			if i > 0 {
				out = append(out, ',')
			}
			encoded, _ := json.Marshal(key)
			out = append(out, encoded...)
			out = append(out, ':')
			var err error
			out, err = appendReply(out, v[key])
			if err != nil {
				return nil, err
			}
		}
		return append(out, '}'), nil
	case []any:
		if v == nil {
			return append(out, "null"...), nil
		}
		return appendList(out, v)
	case []json.RawMessage:
		if v == nil {
			return append(out, "null"...), nil
		}
		return appendList(out, v)
	default:
		encoded, err := json.Marshal(v)
		return append(out, encoded...), err
	}
}

func appendList[T any](out []byte, items []T) ([]byte, error) {
	out = append(out, '[')
	for i, item := range items {
		if i > 0 {
			out = append(out, ',')
		}
		var err error
		out, err = appendReply(out, item)
		if err != nil {
			return nil, err
		}
	}
	return append(out, ']'), nil
}
