package corpus

import (
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

func TestTraceSourceFieldsPreserveScalars(t *testing.T) {
	for _, input := range []string{
		"> extend s source=",
		"> reload s carry=yes source=",
		"> replace-library lib carry=no source=",
	} {
		for _, encoded := range []string{`"é"`, `"e" & fromCodePoint(769)`} {
			t.Run(input+encoded, func(t *testing.T) {
				record, err := ParseRecord(input + encoded)
				if err != nil {
					t.Fatal(err)
				}
				field := record.Fields[len(record.Fields)-1]
				if field.Raw != encoded || field.Value.Kind != value.Text || field.Value.Text() != "e\u0301" {
					t.Fatalf("source scalars changed: %#v", field)
				}
			})
		}
		for _, encoded := range []string{"nothing", "1", `["é"]`, `"é".."z"`} {
			if _, err := ParseRecord(input + encoded); err == nil {
				t.Errorf("accepted non-text source: %s%s", input, encoded)
			}
		}
	}
}

func TestTraceValueTextStillNormalizes(t *testing.T) {
	for _, line := range []string{
		`> answer s/r1.c1 value="é"`,
		`> stub console.read value="e" & fromCodePoint(769)`,
		`vars s source="é"`,
	} {
		record, err := ParseRecord(line)
		if err != nil {
			t.Fatal(err)
		}
		if got := record.Fields[0].Value.Text(); got != "é" {
			t.Errorf("Value text was not normalized: %q", got)
		}
	}
}
