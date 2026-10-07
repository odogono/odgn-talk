package store

import (
	"strings"

	talk "github.com/odogono/odgn-talk/impl/go"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

// EncodeContents writes one JSON object, with each member in the Value
// Encoding. The outer object is a Store, so even $-prefixed keys are literal.
func EncodeContents(entries []talk.Pair) (string, error) {
	var out strings.Builder
	out.WriteByte('{')
	for i, p := range entries {
		encoded, err := talk.EncodeValue(p.Val)
		if err != nil {
			return "", err
		}
		if i > 0 {
			out.WriteByte(',')
		}
		out.WriteString(corevalue.JSONString(p.Key, false))
		out.WriteByte(':')
		out.Write(encoded)
	}
	out.WriteByte('}')
	return out.String(), nil
}

// DecodeContents reads the members of one JSON object, refusing duplicate
// keys, and decoding each member through the Value Encoding.
func DecodeContents(source string) ([]talk.Pair, error) {
	members, err := corevalue.DecodeMembers([]byte(source))
	if err != nil {
		return nil, err
	}
	entries := make([]talk.Pair, len(members))
	for i, p := range members {
		encoded, err := corevalue.Encode(p.Val, false)
		if err != nil {
			return nil, err
		}
		v, err := talk.DecodeValue(encoded, nil)
		if err != nil {
			return nil, err
		}
		entries[i] = talk.KV(p.Key, v)
	}
	return entries, nil
}
