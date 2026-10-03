package unicode

import (
	"slices"
	"unicode/utf8"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
)

// Hangul's algorithmic decomposition and composition constants (UAX #15 §8).
const (
	sBase  = 0xac00
	lBase  = 0x1100
	vBase  = 0x1161
	tBase  = 0x11a7
	lCount = 19
	vCount = 21
	tCount = 28
	nCount = vCount * tCount
	sCount = lCount * nCount
)

func combiningClass(cp rune) int { return property(generated.Combining, cp) }

func decompose(out []rune, cp rune) []rune {
	if index := cp - sBase; index >= 0 && index < sCount {
		out = append(out, lBase+index/nCount, vBase+(index%nCount)/tCount)
		if trail := index % tCount; trail != 0 {
			out = append(out, tBase+trail)
		}
		return out
	}
	if parts, ok := generated.Decomposition[cp]; ok {
		for _, part := range parts {
			out = decompose(out, part)
		}
		return out
	}
	return append(out, cp)
}

func compose(a, b rune) (rune, bool) {
	if a >= lBase && a < lBase+lCount && b >= vBase && b < vBase+vCount {
		return sBase + (a-lBase)*nCount + (b-vBase)*tCount, true
	}
	if a >= sBase && a < sBase+sCount && (a-sBase)%tCount == 0 && b > tBase && b < tBase+tCount {
		return a + b - tBase, true
	}
	cp, ok := generated.Composition[int64(a)*0x110000+int64(b)]
	return cp, ok
}

// NFC refuses invalid UTF-8 and applies canonical decomposition, stable
// combining-class ordering and unblocked canonical composition (UAX #15).
// It preserves BOMs and applies no compatibility or case mappings.
func NFC(text string) (string, error) {
	if !utf8.ValidString(text) {
		return "", errInvalidUTF8
	}
	if text == "" {
		return text, nil
	}
	var decomposed []rune
	for _, cp := range text {
		decomposed = decompose(decomposed, cp)
	}
	// Sort each run of non-starters stably. Unlike insertion sorting, long
	// adversarial combining runs do not require quadratic work.
	start := 0
	for i := 0; i <= len(decomposed); i++ {
		if i == len(decomposed) || combiningClass(decomposed[i]) == 0 {
			slices.SortStableFunc(decomposed[start:i], func(a, b rune) int {
				return combiningClass(a) - combiningClass(b)
			})
			start = i + 1
		}
	}
	out := make([]rune, 0, len(decomposed))
	starter, lastClass := -1, 0
	for _, cp := range decomposed {
		class := combiningClass(cp)
		if starter >= 0 && (lastClass == 0 || lastClass < class) {
			if composed, ok := compose(out[starter], cp); ok {
				out[starter] = composed
				continue
			}
		}
		if class == 0 {
			starter = len(out)
		}
		out = append(out, cp)
		lastClass = class
	}
	return string(out), nil
}

// Fold applies the simple C and S mappings of CaseFolding.txt. It does not
// expand scalars, apply Turkic mappings or normalize the folded result.
func Fold(text string) (string, error) {
	if !utf8.ValidString(text) {
		return "", errInvalidUTF8
	}
	out := []rune(text)
	for i, cp := range out {
		if mapped, ok := generated.Folding[cp]; ok {
			out[i] = mapped
		}
	}
	return string(out), nil
}
