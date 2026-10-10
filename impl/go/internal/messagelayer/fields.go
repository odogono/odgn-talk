package messagelayer

import (
	"encoding/json"
	"math"
	"strconv"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// fields is one message's fields, read as each handler needs them.
type fields map[string]json.RawMessage

func (f fields) has(key string) bool {
	raw, ok := f[key]
	return ok && string(raw) != "null"
}

func (f fields) str(key string) (string, error) {
	var s string
	if err := f.decode(key, &s); err != nil {
		return "", err
	}
	return s, nil
}

func (f fields) optionalStr(key string) (string, error) {
	if !f.has(key) {
		return "", nil
	}
	return f.str(key)
}

func (f fields) bool(key string) (bool, error) {
	if !f.has(key) {
		return false, nil
	}
	var b bool
	err := f.decode(key, &b)
	return b, err
}

// int reads a JSON integer, or the decimal text of one.
func (f fields) int(key string) (int64, error) {
	raw, ok := f[key]
	if !ok {
		return 0, protocolErrorf("missing field %q", key)
	}
	return parseInteger(key, raw)
}

func (f fields) optionalInt(key string) (int64, error) {
	if !f.has(key) {
		return 0, nil
	}
	return f.int(key)
}

func parseInteger(key string, raw json.RawMessage) (int64, error) {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		n, err := strconv.ParseInt(text, 10, 64)
		if err != nil {
			return 0, protocolErrorf("field %q is not an integer", key)
		}
		return n, nil
	}
	var n json.Number
	if err := json.Unmarshal(raw, &n); err != nil {
		return 0, protocolErrorf("field %q is not an integer", key)
	}
	i, err := strconv.ParseInt(n.String(), 10, 64)
	if err != nil || i <= -(1<<53) || i >= 1<<53 {
		return 0, protocolErrorf("field %q is not a safe integer", key)
	}
	return i, nil
}

func (f fields) decode(key string, into any) error {
	raw, ok := f[key]
	if !ok {
		return protocolErrorf("missing field %q", key)
	}
	if err := json.Unmarshal(raw, into); err != nil {
		return protocolErrorf("field %q: %v", key, err)
	}
	return nil
}

func (f fields) sub(key string) (fields, error) {
	var out fields
	if err := f.decode(key, &out); err != nil {
		return nil, err
	}
	if out == nil {
		return nil, protocolErrorf("field %q is not an object", key)
	}
	return out, nil
}

// value reads a field in the Value Encoding, resolving Host Objects against g.
func (f fields) value(key string, g *group) (talk.Value, error) {
	raw, ok := f[key]
	if !ok {
		return talk.Nothing, protocolErrorf("missing field %q", key)
	}
	return decodeValue(raw, g)
}

func (f fields) values(key string, g *group) ([]talk.Value, error) {
	if !f.has(key) {
		return nil, nil
	}
	var raws []json.RawMessage
	if err := f.decode(key, &raws); err != nil {
		return nil, err
	}
	out := make([]talk.Value, len(raws))
	for i, raw := range raws {
		v, err := decodeValue(raw, g)
		if err != nil {
			return nil, err
		}
		out[i] = v
	}
	return out, nil
}

func decodeValue(raw json.RawMessage, g *group) (talk.Value, error) {
	var resolve func(kind, id string) (*talk.Object, bool)
	if g != nil {
		resolve = g.g.ObjectByID
	}
	return talk.DecodeValue(raw, resolve)
}

// instant reads `now`, which is $instant text.
func (f fields) instant(key string) (time.Time, error) {
	text, err := f.str(key)
	if err != nil {
		return time.Time{}, err
	}
	tagged, _ := json.Marshal(map[string]string{"$instant": text})
	v, err := talk.DecodeValue(tagged, nil)
	if err != nil {
		return time.Time{}, protocolErrorf("field %q is not $instant text", key)
	}
	seconds, nanos, _ := v.AsInstant()
	return time.Unix(seconds, int64(nanos)).UTC(), nil
}

// object reads a Host Object handle, [kind, id], in g.
func (f fields) object(key string, g *group) (*talk.Object, error) {
	var pair []string
	if err := f.decode(key, &pair); err != nil {
		return nil, err
	}
	return g.object(key, pair)
}

func (g *group) object(key string, pair []string) (*talk.Object, error) {
	if len(pair) != 2 {
		return nil, protocolErrorf("field %q is not a [kind, id] pair", key)
	}
	o, ok := g.g.ObjectByID(pair[0], pair[1])
	if !ok {
		return nil, protocolErrorf("no Host Object %s/%s in Group %s", pair[0], pair[1], g.g.Name())
	}
	return o, nil
}

func encodeValue(v talk.Value) (json.RawMessage, error) {
	b, err := talk.EncodeValue(v)
	return json.RawMessage(b), err
}

func encodeValues(vs []talk.Value) ([]json.RawMessage, error) {
	out := make([]json.RawMessage, len(vs))
	for i, v := range vs {
		b, err := encodeValue(v)
		if err != nil {
			return nil, err
		}
		out[i] = b
	}
	return out, nil
}

// instantText is the $instant text of t.
func instantText(t time.Time) (string, error) {
	b, err := talk.EncodeValue(talk.InstantFromTime(t))
	if err != nil {
		return "", err
	}
	var tagged map[string]string
	if err := json.Unmarshal(b, &tagged); err != nil {
		return "", err
	}
	return tagged["$instant"], nil
}

func bytesForm(b []byte) json.RawMessage {
	out, _ := talk.EncodeValue(talk.Bytes(b))
	return out
}

// milliseconds reads a whole-millisecond duration.
func milliseconds(n int64) time.Duration {
	if n > math.MaxInt64/int64(time.Millisecond) {
		return math.MaxInt64
	}
	return time.Duration(n) * time.Millisecond
}
