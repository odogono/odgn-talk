package snapshot

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

func TestCompactValuesPreserveGo6Snapshot(t *testing.T) {
	// Written by the 312-byte Value representation at a4770b77. Includes
	// scalar/container kinds, captures and every private machine value kind.
	legacy, err := os.ReadFile("testdata/values-go6.json")
	if err != nil {
		t.Fatal(err)
	}
	codec := Codec{}
	var values []value.Value
	if err := codec.Unmarshal(legacy, &values); err != nil {
		t.Fatal(err)
	}
	got, err := codec.Marshal(values)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, bytes.TrimSpace(legacy)) {
		t.Fatal("compaction changed the go/6 snapshot representation")
	}
}

func TestLegacyNumberWithEmptyUnit(t *testing.T) {
	legacy, err := os.ReadFile("testdata/values-go6.json")
	if err != nil {
		t.Fatal(err)
	}
	var fields []map[string]any
	if err := json.Unmarshal(legacy, &fields); err != nil {
		t.Fatal(err)
	}
	// Before compaction, cancelling Units could leave an empty slice on a
	// dimensionless Number: it is a valid go/6 save with no inactive contents.
	fields[2]["Unit"] = map[string]any{"Slots": []any{}}
	data, err := json.Marshal(fields[2])
	if err != nil {
		t.Fatal(err)
	}
	var got value.Value
	if err := (Codec{}).Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got.Kind != value.Number || got.Number().String() != "42" {
		t.Fatalf("restored Number = %s", got.Display())
	}
}
