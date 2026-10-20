// Package analysis is the Session Host's backend-independent view of source.
// Its data follows chapter 9's analysis-v1 exchanges. The native build keeps
// the retiring Go front end behind talk_native_go; the default build asks
// the embedded Core and never falls back to Go analysis.
package analysis

import "fmt"

type Problem struct {
	Code       string `json:"code"`
	Line       int    `json:"line"`
	Col        int    `json:"col"`
	Incomplete bool   `json:"incomplete"`
	Trailing   bool   `json:"trailing"`
}

func (p *Problem) Error() string { return fmt.Sprintf("%s at %d:%d", p.Code, p.Line, p.Col) }

type Span struct {
	Start   int `json:"start"`
	End     int `json:"end"`
	Line    int `json:"line"`
	EndLine int `json:"endLine"`
}
type Import struct {
	Name  string `json:"name"`
	Local string `json:"local"`
}
type Declaration struct {
	Kind        string   `json:"kind"`
	Name        string   `json:"name"`
	Word        string   `json:"word"`
	Private     bool     `json:"private"`
	Span        Span     `json:"span"`
	Signature   string   `json:"signature"`
	Doc         string   `json:"doc"`
	Arity       []int    `json:"arity"`
	Initializer *string  `json:"initializer"`
	Imports     []Import `json:"imports"`
}
type Entry struct {
	Kind         string        `json:"kind"`
	Doc          string        `json:"doc"`
	Declarations []Declaration `json:"declarations"`
	Implicit     []string      `json:"implicit"`
	Problem      *Problem      `json:"problem"`
}
type Builtin struct{ Name, Call, Gives string }
type Library struct{ Name, Source string }
type Catalog struct {
	Builtins      []Builtin `json:"builtins"`
	Libraries     []Library `json:"libraries"`
	InspectReader string    `json:"inspectReader"`
}
