package check

import (
	"github.com/odogono/odgn-talk/impl/go/internal/syntax"
	"testing"
)

func TestCollectingTargets(t *testing.T) {
	for _, tc := range []struct {
		source, code string
		line, col    int
	}{
		{"script variable acc\non t\n repeat 0 times collecting 1 into acc\n end repeat\nend t", "name clash", 3, 35},
		{"on t\n repeat for each acc in [] collecting acc into acc\n end repeat\nend t", "name clash", 2, 48},
		{"on t\n repeat 1 times collecting 1 into acc\n put 1 into acc\n end repeat\nend t", "can't write", 3, 13},
		{"on t\n repeat 1 times collecting 1 into acc\n put 1 into item 1 of acc\n end repeat\nend t", "can't write", 3, 23},
		{"on t\n repeat 1 times collecting 1 into acc\n let [acc] be []\n end repeat\nend t", "can't write", 3, 7},
		{"on t\n repeat 1 times collecting 1 into acc\n repeat 0 times collecting 1 into acc\n end repeat\n end repeat\nend t", "can't write", 3, 35},
		{"constant acc = 1\non t\n repeat 0 times collecting 1 into acc\n end repeat\nend t", "name clash", 3, 35},
		{"on t\n repeat 0 times collecting 1 into acc\n end repeat\nend t\nconstant acc = 1", "name clash", 5, 10},
		{"on t\n repeat 1 times collecting 1 into acc\n repeat for each acc in []\n end repeat\n end repeat\nend t", "can't write", 3, 18},
		{"on t\n repeat 1 times collecting 1 into acc\n try\n catch acc\n end try\n end repeat\nend t", "can't write", 4, 8},
		{"on t\n repeat 1 times collecting 1 into acc\n add 1 to acc\n end repeat\nend t", "can't write", 3, 11},
		{"on t\n repeat 1 times collecting 1 into acc\n put given\n put [] into acc\n end given into f\n end repeat\nend t", "can't write", 4, 14},
		{"on t\n repeat 1 times collecting 1 into acc\n let <acc: digit> be \"1\"\n end repeat\nend t", "can't write", 3, 7},

		{"on t\n repeat 1 times collecting 1 into t\n end repeat\n return t\nend t", "", 0, 0},

		{"on t\n say acc\n repeat while the length of acc < 2 collecting 1 into acc\n say acc\n end repeat\n return acc\nend t", "", 0, 0},
		{"on t\n repeat 1 times collecting 1 into acc\n put given acc: acc into f\n end repeat\n put [] into acc\nend t", "", 0, 0},
	} {
		tree, err := syntax.Parse(tc.source)
		if err != nil {
			t.Fatal(err)
		}
		u := Check(tree, Options{})
		if tc.code == "" {
			if len(u.Diagnostics) != 0 {
				t.Fatal(u.Diagnostics)
			}
			continue
		}
		if len(u.Diagnostics) != 1 || u.Diagnostics[0].Code != tc.code || u.Diagnostics[0].Pos != (syntax.Position{Line: tc.line, Column: tc.col}) {
			t.Errorf("%s: %v", tc.source, u.Diagnostics)
		}
	}
}

func TestCollectingTargetClashesWithObject(t *testing.T) {
	tree, err := syntax.Parse("on t\n repeat 0 times collecting 1 into acc\n end repeat\nend t")
	if err != nil {
		t.Fatal(err)
	}
	u := Check(tree, Options{Objects: []string{"acc"}})
	if len(u.Diagnostics) != 1 || u.Diagnostics[0].Code != "name clash" || u.Diagnostics[0].Pos != (syntax.Position{Line: 2, Column: 35}) {
		t.Fatal(u.Diagnostics)
	}
}
