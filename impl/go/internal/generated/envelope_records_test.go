package generated

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// Every JSON-layout vector decodes strictly into its generated record and
// encodes back to the same tree (ADR 0183).
func TestEnvelopeRecordsRoundTripJSONVectors(t *testing.T) {
	data, err := os.ReadFile("../../../testdata/envelope-frames.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Name, Message, View, Tree string
		Tag                       byte
		Hex                       string
	}
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, vector := range vectors {
		key := ""
		switch {
		case vector.View != "":
			key = "view:" + vector.View
		case vector.Message != "":
			key = "json message:" + vector.Message
		default:
			for _, e := range EnvelopeMessages {
				if e.Tag == vector.Tag && len(e.Layouts) == 2 {
					key = "message:" + e.Name
				}
			}
		}
		if key == "" {
			continue
		}
		checked++
		t.Run(vector.Name, func(t *testing.T) {
			tree := decode(t, vector.Tree)
			delete(tree, "m") // the dispatch tag, not a field
			plain, _ := json.Marshal(tree)
			record := EnvelopeRecords[key]()
			strict := json.NewDecoder(bytes.NewReader(plain))
			strict.DisallowUnknownFields()
			strict.UseNumber()
			if err := strict.Decode(record); err != nil {
				t.Fatalf("%s: %v", key, err)
			}
			again, err := json.Marshal(record)
			if err != nil {
				t.Fatal(err)
			}
			if got := decode(t, string(again)); !reflect.DeepEqual(got, tree) {
				t.Fatalf("%s round trip\n got %v\nwant %v", key, got, tree)
			}
		})
	}
	if checked == 0 {
		t.Fatal("no JSON-layout vectors")
	}
}

func decode(t *testing.T, text string) map[string]any {
	t.Helper()
	d := json.NewDecoder(bytes.NewReader([]byte(text)))
	d.UseNumber()
	var tree map[string]any
	if err := d.Decode(&tree); err != nil {
		t.Fatal(err)
	}
	return tree
}
