package lower

import (
	"github.com/odogono/odgn-talk/impl/go/internal/check"
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"testing"
)

func TestRecoveryOffersLowered(t *testing.T) {
	for _, source := range []string{
		"on t\ntry\noffer skip\nend try\nend t",
		"on t\ntry\ncatch e before unwind\nend try\nend t",
		"on t\ntry\ncatch e before unwind\nchoose offer skip\nend try\nend t",
	} {
		tree, err := syntax.Parse(source)
		if err != nil {
			t.Fatal(err)
		}
		checked := check.Check(tree, check.Options{})
		if len(checked.Diagnostics) > 0 {
			t.Fatal(checked.Diagnostics)
		}
		unit, err := Compile(checked, "test")
		if unit == nil || err != nil {
			t.Fatalf("unit %v, error %v", unit, err)
		}
	}
}
