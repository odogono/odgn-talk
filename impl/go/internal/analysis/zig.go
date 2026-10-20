package analysis

import (
	"encoding/json"
	"sync"
)

// Exchange is installed by the Zig backend, sharing its compiled reactor.
// It returns the ok body of one negotiated analysis-v1 exchange.
var Exchange func(method string, fields map[string]any) (json.RawMessage, error)

func request(method string, fields map[string]any, out any) error {
	data, err := Exchange(method, fields)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}
func ParseEntry(source string, handlers, bound []string) (*Entry, error) {
	var e Entry
	fields := map[string]any{"source": source}
	if len(handlers) > 0 {
		fields["handlers"] = handlers
	}
	if len(bound) > 0 {
		fields["bound"] = bound
	}
	if err := request("analyze-entry", fields, &e); err != nil {
		return nil, err
	}
	if e.Problem != nil {
		return nil, e.Problem
	}
	return &e, nil
}
func Source(source string) ([]Declaration, error) {
	var r struct {
		Declarations []Declaration `json:"declarations"`
		Problem      *Problem      `json:"problem"`
	}
	if err := request("analyze-source", map[string]any{"source": source}, &r); err != nil {
		return nil, err
	}
	if r.Problem != nil {
		return nil, r.Problem
	}
	return r.Declarations, nil
}

var catalogue = sync.OnceValue(func() *Catalog {
	var c Catalog
	if err := request("analysis-catalogue", nil, &c); err != nil {
		panic(err)
	}
	return &c
})

// Catalogue returns immutable Core data, fetched once per process.
func Catalogue() *Catalog { return catalogue() }
func ValidMessageName(name string, arity int) bool {
	var r struct {
		Valid bool `json:"valid"`
	}
	if err := request("message-name", map[string]any{"name": name, "arity": arity}, &r); err != nil {
		panic(err)
	}
	return r.Valid
}
