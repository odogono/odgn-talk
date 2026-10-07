package check

import (
	"encoding/json"
	"errors"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"os"
	"reflect"
	"testing"
)

func TestRecoveryOfferFixtures(t *testing.T) {
	data, err := os.ReadFile("../../../../tools/grammar/recovery-offers.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name             string
		Source           string
		SyntaxError      bool
		Diagnostics      [][]any
		SyntaxDiagnostic []any
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			tree, err := syntax.Parse(tc.Source)
			if (err != nil) != tc.SyntaxError {
				t.Fatalf("syntax: %v", err)
			}
			if tc.SyntaxError {
				var diagnostic *syntax.Error
				if !errors.As(err, &diagnostic) {
					t.Fatal(err)
				}
				got := []any{diagnostic.Code, float64(diagnostic.Pos.Line), float64(diagnostic.Pos.Column)}
				if !reflect.DeepEqual(got, tc.SyntaxDiagnostic) {
					t.Fatalf("got %v; want %v", got, tc.SyntaxDiagnostic)
				}
				return
			}
			if tree.Source() != tc.Source {
				t.Fatal("lossless source differs")
			}
			u := Check(tree, Options{})
			got := [][]any{}
			for _, d := range u.Diagnostics {
				got = append(got, []any{d.Code, float64(d.Pos.Line), float64(d.Pos.Column)})
			}
			if !reflect.DeepEqual(got, tc.Diagnostics) {
				t.Fatalf("got %v; want %v", got, tc.Diagnostics)
			}
		})
	}
}
