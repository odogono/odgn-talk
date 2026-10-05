package northtalk

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"slices"
	"time"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
	"github.com/odogono/odgn-talk/impl/go/internal/shape"
	corevalue "github.com/odogono/odgn-talk/impl/go/internal/value"
)

func jsonData(v any) []byte {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		panic(err)
	}
	return bytes.TrimSuffix(b.Bytes(), []byte{'\n'})
}
func shapeData(s shape.Shape) any {
	switch s.Kind {
	case "", "any", "value":
		return s.Kind
	case "kind":
		return s.Name
	case "object", "quantity", "unitKind":
		return map[string]any{s.Kind: s.Name}
	case "optional", "list":
		return map[string]any{s.Kind: shapeData(s.Of[0])}
	case "oneOf":
		xs := []any{}
		for _, x := range s.Of {
			xs = append(xs, shapeData(x))
		}
		return map[string]any{"oneOf": xs}
	case "map":
		return struct {
			Map  []fieldData `json:"map"`
			Open bool        `json:"open,omitempty"`
		}{fieldsData(s.Fields), s.Open}
	}
	panic("unknown Shape")
}

type fieldData struct {
	Key      string `json:"key"`
	Shape    any    `json:"shape"`
	Optional bool   `json:"optional,omitempty"`
}

func fieldsData(fs []shape.Field) []fieldData {
	out := []fieldData{}
	for _, f := range fs {
		out = append(out, fieldData{f.Key, shapeData(f.Shape), f.Optional})
	}
	return out
}
func publicFieldsData(fs []Field) []fieldData {
	out := []fieldData{}
	for _, f := range fs {
		out = append(out, fieldData{f.Key, shapeData(f.Shape.inner), f.Optional})
	}
	return out
}

type errorData struct {
	Code   string      `json:"code"`
	Fields []fieldData `json:"fields"`
}
type opData struct {
	Name   string `json:"name"`
	Mode   string `json:"mode"`
	Args   []any  `json:"args"`
	Result any    `json:"result,omitempty"`
	Cost   struct {
		Fuel  int64 `json:"fuel"`
		Alloc int64 `json:"alloc"`
	} `json:"cost"`
	MaxPending   *int64       `json:"maxPending,omitempty"`
	Errors       *[]errorData `json:"errors,omitempty"`
	Scope        any          `json:"scope,omitempty"`
	SegmentBound bool         `json:"segmentBound,omitempty"`
}

func operationData(op Operation) opData {
	out := opData{Name: op.Name, Mode: modeName(op.Mode), Args: []any{}, SegmentBound: op.SegmentBound}
	for _, arg := range op.Args {
		out.Args = append(out.Args, shapeData(arg.inner))
	}
	if op.Result.inner.Kind != "" {
		out.Result = shapeData(op.Result.inner)
	}
	out.Cost.Fuel, out.Cost.Alloc = op.Cost.Fuel, op.Cost.Alloc
	if op.MaxPending != 0 {
		ms := int64(op.MaxPending / time.Millisecond)
		out.MaxPending = &ms
	}
	if op.Errors != nil {
		es := []errorData{}
		for _, e := range op.Errors {
			es = append(es, errorData{e.Code, publicFieldsData(e.Fields)})
		}
		slices.SortFunc(es, func(a, b errorData) int { return cmpString(a.Code, b.Code) })
		out.Errors = &es
	}
	if op.Scope != nil {
		if op.Scope.Opens != "" {
			out.Scope = struct {
				Opens   string `json:"opens"`
				Abandon string `json:"abandon"`
			}{op.Scope.Opens, op.Scope.Abandon}
		} else {
			out.Scope = map[string]string{"closes": op.Scope.Closes}
		}
	}
	return out
}
func cmpString(a, b string) int {
	if a < b {
		return -1
	}
	if a > b {
		return 1
	}
	return 0
}

type grantDeclaration struct {
	Capability string   `json:"capability"`
	Operations []opData `json:"operations"`
}

func grantData(g *Grant) grantDeclaration {
	out := grantDeclaration{g.definition.name, []opData{}}
	names := []string{}
	for n, kept := range g.operations {
		if kept {
			names = append(names, n)
		}
	}
	slices.Sort(names)
	for _, n := range names {
		out.Operations = append(out.Operations, operationData(g.definition.ops[n]))
	}
	return out
}
func limitsData(l Limits) any {
	return struct {
		Fuel       int64 `json:"fuelPerRun"`
		Alloc      int64 `json:"allocPerRun"`
		Persistent int64 `json:"persistentState"`
		Depth      int   `json:"callDepth"`
		Pattern    int   `json:"patternSize"`
		Mailbox    int   `json:"mailboxDepth"`
		Wait       int64 `json:"maxWaitMs"`
		Join       int   `json:"maxJoin"`
		Cleanup    int64 `json:"cleanupBudget"`
	}{l.FuelPerRun, l.AllocPerRun, l.PersistentState, l.CallDepth, l.PatternSize, l.MailboxDepth, int64(l.MaxWait / time.Millisecond), l.MaxJoin, l.CleanupBudget}
}
func (g *Group) fingerprint() [32]byte {
	type scriptData struct {
		Name     string                      `json:"name"`
		Identity string                      `json:"identity"`
		Grants   map[string]grantDeclaration `json:"grants"`
		Limits   any                         `json:"limits"`
	}
	ss := slices.Clone(g.scripts)
	slices.SortFunc(ss, func(a, b *Script) int { return cmpString(a.name, b.name) })
	scripts := []scriptData{}
	for _, s := range ss {
		grants := map[string]grantDeclaration{}
		for name, grant := range s.grants {
			grants[name] = grantData(grant)
		}
		scripts = append(scripts, scriptData{s.name, fmt.Sprintf("%x", s.identity), grants, limitsData(s.limits)})
	}
	names := []string{}
	for n := range g.libraries {
		if standardLibraries()[n] == nil {
			names = append(names, n)
		}
	}
	slices.Sort(names)
	libraries := [][2]string{}
	for _, n := range names {
		libraries = append(libraries, [2]string{n, fmt.Sprintf("%x", g.libraries[n].id)})
	}
	v := CoreVersions()
	return sha256.Sum256(fingerprintJSON(struct {
		Language  string       `json:"language"`
		Cost      int          `json:"costModel"`
		Libraries [][2]string  `json:"libraries"`
		Scripts   []scriptData `json:"scripts"`
	}{v.Language, int(generated.Costs.Version), libraries, scripts}))
}

// Fingerprint covers declarations, code identities and limits, never state.
func (g *Group) Fingerprint() [32]byte {
	if err := g.beginWorker(); err != nil {
		panic(err)
	}
	defer g.endWorker()
	return g.fingerprint()
}

// Fingerprint strings use the tagged JSON escape rule from chapter 9. Go's
// JSON encoder supplies field order and numbers; rewrite its string tokens to
// retain non-control Unicode and use long escapes for every control scalar.
func fingerprintJSON(v any) []byte {
	data := jsonData(v)
	var out bytes.Buffer
	for i := 0; i < len(data); {
		if data[i] != '"' {
			out.WriteByte(data[i])
			i++
			continue
		}
		end := i + 1
		for end < len(data) {
			if data[end] == '\\' {
				end += 2
				continue
			}
			if data[end] == '"' {
				break
			}
			end++
		}
		var token string
		if err := json.Unmarshal(data[i:end+1], &token); err != nil {
			panic(err)
		}
		out.WriteString(corevalue.JSONString(token, false))
		i = end + 1
	}
	return out.Bytes()
}
