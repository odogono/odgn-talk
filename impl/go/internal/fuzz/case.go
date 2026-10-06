// Package fuzz runs differential fuzz cases on the Go Core for the fuzzer in
// tooling/fuzz. Cases, results and the worker protocol follow its model.ts and
// worker.ts; references are resolved as its runner.ts resolves them.
package fuzz

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/odogono/odgn-talk/impl/go/internal/corpus"
)

// Features lists the generator features this runner supports.
var Features = []string{"compute", "dispatch", "suspend", "join", "decision", "error", "scope", "effect", "loop", "send", "timer"}

// Action is an abstract Host Input; all but `input` hold symbolic references.
type Action struct {
	Kind          string  `json:"kind"`
	Line          string  `json:"line"`
	Nth           int     `json:"nth"`
	Value         *string `json:"value"`
	Script        string  `json:"script"`
	VariablesOnly bool    `json:"variablesOnly"`
	How           string  `json:"how"`
}

type Case struct {
	Inputs []Action
	Setup  corpus.Setup
}

type Execution struct {
	Counts       Counts        `json:"counts"`
	Fingerprints []Fingerprint `json:"fingerprints"`
	Trace        []string      `json:"trace"`
}

type Counts struct {
	Actions map[string]int `json:"actions"`
	Applied int            `json:"applied"`
	Noops   int            `json:"noops"`
	Records map[string]int `json:"records"`
}

type Fingerprint struct {
	Action string `json:"action"`
	After  string `json:"after"`
	Before string `json:"before"`
}

type Signature struct {
	Field  string `json:"field"`
	Oracle string `json:"oracle"`
	Owner  string `json:"owner"`
	Record string `json:"record"`
}

type Finding struct {
	Classification string    `json:"classification"`
	Message        string    `json:"message"`
	Signature      Signature `json:"signature"`
}

type Result struct {
	Execution *Execution `json:"execution,omitempty"`
	Findings  []Finding  `json:"findings"`
}

// ReadCase accepts what model.ts's readCase accepts. Saved sources and inputs
// are authoritative; the generator's choices are not needed to run a case.
func ReadCase(raw json.RawMessage) (Case, error) {
	var c struct {
		Version   int             `json:"version"`
		Seed      *string         `json:"seed"`
		Generator *string         `json:"generator"`
		Profile   []string        `json:"profile"`
		Inputs    []Action        `json:"inputs"`
		Setup     json.RawMessage `json:"setup"`
	}
	malformed := fmt.Errorf("Unsupported or malformed Fuzz Case")
	if err := json.Unmarshal(raw, &c); err != nil {
		return Case{}, malformed
	}
	if c.Version != 1 || c.Inputs == nil || c.Profile == nil || c.Seed == nil || c.Generator == nil {
		return Case{}, malformed
	}
	d := json.NewDecoder(bytes.NewReader(c.Setup))
	d.UseNumber()
	var setup any
	if err := d.Decode(&setup); err != nil {
		return Case{}, malformed
	}
	converted, err := setupValue(setup)
	if err != nil {
		return Case{}, err
	}
	s, ok := converted.(corpus.Setup)
	if !ok {
		return Case{}, malformed
	}
	if _, ok := s["scripts"].([]any); !ok {
		return Case{}, malformed
	}
	return Case{Inputs: c.Inputs, Setup: s}, nil
}

// setupValue gives JSON the shapes case.toml's reader produces: tables as
// Setup and integers as int64.
func setupValue(v any) (any, error) {
	switch v := v.(type) {
	case map[string]any:
		out := corpus.Setup{}
		for k, x := range v {
			converted, err := setupValue(x)
			if err != nil {
				return nil, err
			}
			out[k] = converted
		}
		return out, nil
	case []any:
		out := make([]any, len(v))
		for i, x := range v {
			converted, err := setupValue(x)
			if err != nil {
				return nil, err
			}
			out[i] = converted
		}
		return out, nil
	case json.Number:
		n, err := v.Int64()
		if err != nil {
			return nil, fmt.Errorf("setup number %s is not an integer", v)
		}
		return n, nil
	}
	return v, nil
}
