package machine

import (
	"fmt"
	"strings"
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

// Chapter 8 makes these programs normative: alternate encodings would change
// thread counts, logical Pattern sizes and make-pattern charges.
func TestNormativePatternPrograms(t *testing.T) {
	for _, tc := range []struct{ source, program string }{
		{`<>`, `match`},
		{`<"q́">`, `char "q́"; match`},
		{`<"A" ignoring case>`, `char "A" fold; match`},
		{`<digit>`, `class digit; match`},
		{`<digits>`, `class digit; split 0 2; match`},
		{`<digits lazily>`, `class digit; split 2 0; match`},
		{`<text>`, `split 1 3; class any; jump 0; match`},
		{`<optional "x">`, `split 1 2; char "x"; match`},
		{`<optional "x" lazily>`, `split 2 1; char "x"; match`},
		{`<"a" or "b">`, `split 1 3; char "a"; jump 4; char "b"; match`},
		{`<n: digits as number>`, `save 0; class digit; split 1 3; save 1; match`},
		{`<a number>`, `split 1 2; char "-"; class digit; split 2 4; split 5 8; char "."; class digit; split 6 8; match`},
		{`<3 uppercase letters>`, `class uppercase; class uppercase; class uppercase; match`},
		{`<0 words>`, `match`},
		{`<2 words>`, `class nonspace; split 0 2; class whitespace; split 2 4; class nonspace; split 4 6; match`},
		{`<text start, word break, line end>`, `assert text start; assert word break; assert line end; match`},
		{`< <digits> lazily>`, `class digit; split 0 2; match`},
	} {
		t.Run(tc.source, func(t *testing.T) {
			v, err := value.ParsePattern(tc.source)
			if err != nil {
				t.Fatal(err)
			}
			p, err := compilePattern(v, false)
			if err != nil {
				t.Fatal(err)
			}
			var code []string
			for _, i := range p.Code {
				s := i.Op
				switch i.Op {
				case "char":
					s += fmt.Sprintf(" %q", i.Text)
					if i.Fold {
						s += " fold"
					}
				case "class", "assert":
					s += " " + i.Text
				case "jump", "save":
					s += fmt.Sprintf(" %d", i.A)
				case "split":
					s += fmt.Sprintf(" %d %d", i.A, i.B)
				}
				code = append(code, s)
			}
			if got := strings.Join(code, "; "); got != tc.program {
				t.Fatalf("program: %s\nwant:    %s", got, tc.program)
			}
		})
	}
}
