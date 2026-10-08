package session

import (
	"encoding/json"
	"fmt"
	v "github.com/odogono/odgn-talk/impl/go/internal/value"
	"math/big"
	"slices"
	"strings"
	"unicode/utf8"
)

// Envelope is raw ordered Value Encoding inside a strict JSON framing object.
type Envelope map[string]json.RawMessage

func envelopeError(what string) { panic(fmt.Errorf("Malformed Transcript: %s", what)) }
func envelopeObject(raw []byte) Envelope {
	var e Envelope
	if len(raw) == 0 || raw[0] != '{' {
		envelopeError("expected object")
	}
	if err := json.Unmarshal(raw, &e); err != nil {
		envelopeError(err.Error())
	}
	return e
}
func envelopeText(raw []byte) string {
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		envelopeError("expected text")
	}
	return s
}
func envelopeFields(e Envelope, required []string, optional ...string) {
	for _, k := range required {
		if _, ok := e[k]; !ok {
			envelopeError("missing field " + k)
		}
	}
	for k := range e {
		if !slices.Contains(required, k) && !slices.Contains(optional, k) {
			envelopeError("extra field " + k)
		}
	}
}
func envelopeCounter(raw []byte) *big.Int {
	s := string(raw)
	if strings.HasPrefix(s, `"`) {
		s = envelopeText(raw)
	}
	n, ok := new(big.Int).SetString(s, 10)
	if !ok || n.Sign() <= 0 || n.String() != s {
		envelopeError("invalid counter")
	}
	boundary := new(big.Int).Lsh(big.NewInt(1), 53)
	if strings.HasPrefix(string(raw), `"`) != (n.Cmp(boundary) >= 0) {
		envelopeError("invalid counter encoding")
	}
	return n
}
func counterJSON(n *big.Int) json.RawMessage {
	if n.BitLen() > 53 || n.Cmp(new(big.Int).Lsh(big.NewInt(1), 53)) >= 0 {
		return rawJSON(n.String())
	}
	return json.RawMessage(n.String())
}
func rawJSON(x any) json.RawMessage {
	switch x := x.(type) {
	case json.RawMessage:
		return x
	case string:
		return json.RawMessage(v.JSONString(x, false))
	case []json.RawMessage:
		xs := []string{}
		for _, raw := range x {
			xs = append(xs, string(raw))
		}
		return json.RawMessage("[" + strings.Join(xs, ",") + "]")
	case []any:
		xs := []string{}
		for _, raw := range x {
			xs = append(xs, string(rawJSON(raw)))
		}
		return json.RawMessage("[" + strings.Join(xs, ",") + "]")
	case map[string]any:
		e := Envelope{}
		for k, val := range x {
			e[k] = rawJSON(val)
		}
		return json.RawMessage(writeEnvelope(e))
	}
	b, err := json.Marshal(x)
	if err != nil {
		envelopeError(err.Error())
	}
	// Canonical string escaping and key order for struct declaration data.
	var plain any
	decoder := json.NewDecoder(strings.NewReader(string(b)))
	decoder.UseNumber()
	if err := decoder.Decode(&plain); err != nil {
		envelopeError(err.Error())
	}
	return canonicalData(plain)
}
func canonicalData(x any) json.RawMessage {
	switch x := x.(type) {
	case string:
		return json.RawMessage(v.JSONString(x, false))
	case map[string]any:
		e := Envelope{}
		for k, val := range x {
			e[k] = canonicalData(val)
		}
		return json.RawMessage(writeEnvelope(e))
	case []any:
		xs := []json.RawMessage{}
		for _, val := range x {
			xs = append(xs, canonicalData(val))
		}
		return rawJSON(xs)
	}
	b, err := json.Marshal(x)
	if err != nil {
		envelopeError(err.Error())
	}
	return b
}
func envelopeRef(raw []byte) objectReference {
	e := envelopeObject(raw)
	envelopeFields(e, []string{"kind", "id"})
	r := objectReference{envelopeText(e["kind"]), envelopeText(e["id"])}
	if r.kind == "" {
		envelopeError("empty kind")
	}
	return r
}
func ParseEnvelope(source string) (e Envelope, err error) {
	defer func() {
		if p := recover(); p != nil {
			if x, ok := p.(error); ok {
				err = x
			} else {
				panic(p)
			}
		}
	}()
	if !utf8.ValidString(source) {
		return nil, fmt.Errorf("invalid UTF-8")
	}
	// The ordered plain JSON reader rejects duplicate keys at every depth.
	if _, err = v.Decode([]byte(source), false, nil); err != nil {
		return nil, err
	}
	e = envelopeObject([]byte(strings.TrimSpace(source)))
	typ := envelopeText(e["type"])
	switch typ {
	case "kind":
		envelopeFields(e, []string{"type", "name", "props", "parentKinds"})
		if envelopeText(e["name"]) == "" {
			envelopeError("empty kind")
		}
		var ps []Envelope
		if json.Unmarshal(e["props"], &ps) != nil || ps == nil {
			envelopeError("invalid properties")
		}
		seen := map[string]bool{}
		for _, p := range ps {
			envelopeFields(p, []string{"name", "shape", "readOnly", "getCost"}, "setCost")
			name := envelopeText(p["name"])
			if name == "" || seen[name] {
				envelopeError("duplicate/empty property")
			}
			seen[name] = true
			readOnly := envelopeBool(p["readOnly"])
			_, set := p["setCost"]
			if set == readOnly {
				envelopeError("invalid setCost")
			}
			decodeEnvelopeShape(p["shape"])
			decodeEnvelopeCost(p["getCost"])
			if set {
				decodeEnvelopeCost(p["setCost"])
			}
		}
		var parents []string
		if json.Unmarshal(e["parentKinds"], &parents) != nil || parents == nil {
			envelopeError("invalid parent kinds")
		}
	case "object":
		envelopeFields(e, []string{"type", "object"})
		envelopeRef(e["object"])
	case "setup":
		envelopeFields(e, []string{"type", "objects"})
		for _, r := range envelopeObject(e["objects"]) {
			envelopeRef(r)
		}
	case "property-begin":
		envelopeFields(e, []string{"type", "crossing", "object", "property", "operation"}, "value")
		envelopeCounter(e["crossing"])
		envelopeRef(e["object"])
		envelopeText(e["property"])
		op := envelopeText(e["operation"])
		_, value := e["value"]
		if op != "get" && op != "set" || value != (op == "set") {
			envelopeError("invalid operation")
		}
	case "property-end":
		envelopeFields(e, []string{"type", "crossing", "reply"})
		envelopeCounter(e["crossing"])
		r := envelopeObject(e["reply"])
		if len(r) != 1 {
			envelopeError("invalid property reply")
		}
		for k := range r {
			if !slices.Contains([]string{"value", "ok", "fail", "hostError"}, k) {
				envelopeError("invalid property reply")
			}
			if (k == "ok" || k == "hostError") && !envelopeBool(r[k]) {
				envelopeError("invalid property reply flag")
			}
			if k == "fail" {
				validateFailure(r[k])
			}
		}
	case "function":
		envelopeFields(e, []string{"type", "handle", "exposure", "path"})
		h := envelopeText(e["handle"])
		if len(h) < 2 || h[0] != 'f' {
			envelopeError("invalid function handle")
		}
		n, ok := new(big.Int).SetString(h[1:], 10)
		if !ok || n.Sign() <= 0 || n.String() != h[1:] {
			envelopeError("invalid function handle")
		}
		envelopeCounter(e["exposure"])
		var path []json.RawMessage
		if json.Unmarshal(e["path"], &path) != nil || path == nil {
			envelopeError("invalid path")
		}
		for _, p := range path {
			if p[0] == '"' {
				envelopeText(p)
			} else {
				var n int64
				if json.Unmarshal(p, &n) != nil || n < 0 || n >= 9007199254740992 {
					envelopeError("invalid path")
				}
			}
		}
	case "input":
		envelopeFields(e, []string{"type", "request", "reply"})
		validateRequest(envelopeObject(e["request"]))
		r := envelopeObject(e["reply"])
		if len(r) != 1 {
			envelopeError("invalid input reply")
		}
		if x, ok := r["ok"]; ok {
			payload := envelopeObject(x)
			envelopeFields(payload, nil, "delivery", "broadcast")
			if len(payload) > 1 {
				envelopeError("invalid input reply")
			}
			for _, raw := range payload {
				envelopeText(raw)
			}
		} else {
			envelopeFields(r, []string{"error"})
			envelopeText(r["error"])
		}
	case "resolve":
		envelopeFields(e, []string{"type", "objects"})
		var outcomes []Envelope
		if json.Unmarshal(e["objects"], &outcomes) != nil || outcomes == nil {
			envelopeError("invalid resolver outcomes")
		}
		for _, o := range outcomes {
			envelopeFields(o, []string{"object", "resolved"})
			envelopeRef(o["object"])
			envelopeBool(o["resolved"])
		}
	default:
		envelopeError("unknown envelope type")
	}
	return
}
func envelopeBool(raw []byte) bool {
	var b bool
	if string(raw) != "true" && string(raw) != "false" {
		envelopeError("expected boolean")
	}
	json.Unmarshal(raw, &b)
	return b
}

// Sort framing/declaration fields; Raw Value positions bypass recursive sorting.
func writeEnvelope(e Envelope) string {
	keys := []string{}
	for k := range e {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	var b strings.Builder
	b.WriteByte('{')
	for i, k := range keys {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(v.JSONString(k, false))
		b.WriteByte(':')
		b.Write(e[k])
	}
	b.WriteByte('}')
	return b.String()
}
