package store_test

import (
	"testing"

	"github.com/odogono/odgn-talk/impl/go/store"
)

func TestContentsRefuseNoncanonicalValues(t *testing.T) {
	for _, s := range []string{
		`{"$dec":"01"}`, `{"$dec":"3"}`, `{"$dec":"-9007199254740991"}`,
		`1.0`, `-0`, `1e2`,
		`{"$quantity":["3","days"]}`, `{"$quantity":["1","m/m"]}`,
		`{"$instant":"1970-01-01T01:00:00+01:00"}`,
		`{"$instant":"1970-01-01T00:00:00.500Z"}`, `{"$instant":"1970-01-01T00:00:00.0Z"}`,
		`{"$date":"2026-09-27T00:00:00.0"}`, `{"$map":[["a",1]]}`, `{"$map":[]}`,
	} {
		if _, err := store.DecodeContents(`{"$literal":[` + s + `]}`); err == nil {
			t.Errorf("Store accepted %s", s)
		}
	}
}

func TestContentsCanonicalRoundTrip(t *testing.T) {
	for _, s := range []string{
		`{}`, `{"$dec":3}`, `{"a":[1,{"$dec":"2.50"}],"$literal":{"$map":[["$x",2]]}}`,
	} {
		entries, err := store.DecodeContents(s)
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := store.EncodeContents(entries)
		if err != nil || encoded != s {
			t.Fatalf("re-encoding %s: got %s %v", s, encoded, err)
		}
	}
}
