package unicode

import (
	"errors"
	"sort"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
)

var errInvalidUTF8 = errors.New("invalid UTF-8 text")

func property[T any](table []generated.PropertyRange[T], cp rune) T {
	i := sort.Search(len(table), func(i int) bool { return table[i].End >= cp })
	if i < len(table) && table[i].Start <= cp {
		return table[i].Value
	}
	var zero T
	return zero
}

// WhiteSpace is the pinned White_Space property of one scalar. A Character is
// White_Space exactly when its first scalar is (chapter 4).
func WhiteSpace(cp rune) bool { return property(generated.Whitespace, cp) != 0 }
