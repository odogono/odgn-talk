package unicode

import (
	"unicode/utf8"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
)

func control(value string) bool { return value == "CR" || value == "LF" || value == "Control" }

// Boundaries gives UAX #29 extended grapheme boundaries, including byte offsets
// 0 and len(text). Empty text has the single sentinel 0 and no Characters.
// Lookbehind state is retained in one pass, including Unicode 18's GB9c.
func Boundaries(text string) ([]int, error) {
	if !utf8.ValidString(text) {
		return nil, errInvalidUTF8
	}
	boundaries := []int{0}
	previous := ""
	regionalCount := 0
	linkerBefore, pictographicExtend, zwjAfterPictographic := false, false, false
	for offset, cp := range text {
		current := property(generated.Grapheme, cp)
		indic := property(generated.Indic, cp)
		pictographic := property(generated.Pictographic, cp) != 0
		if offset != 0 {
			join := false
			switch {
			case previous == "CR" && current == "LF": // GB3
				join = true
			case control(previous) || control(current): // GB4–5
			case previous == "L" && (current == "L" || current == "V" || current == "LV" || current == "LVT"): // GB6
				join = true
			case (previous == "LV" || previous == "V") && (current == "V" || current == "T"): // GB7
				join = true
			case (previous == "LVT" || previous == "T") && current == "T": // GB8
				join = true
			case current == "Extend" || current == "ZWJ" || current == "SpacingMark" || previous == "Prepend": // GB9–9b
				join = true
			case indic == "Consonant" && linkerBefore: // GB9c: Linker Extend* × Consonant
				join = true
			case pictographic && zwjAfterPictographic: // GB11
				join = true
			case previous == "Regional_Indicator" && current == "Regional_Indicator" && regionalCount%2 == 1: // GB12–13
				join = true
			}
			if !join {
				boundaries = append(boundaries, offset)
			} // GB999
		}
		if indic != "Extend" {
			linkerBefore = indic == "Linker"
		}
		zwjAfterPictographic = current == "ZWJ" && pictographicExtend
		if current != "Extend" {
			pictographicExtend = pictographic
		}
		if current == "Regional_Indicator" {
			regionalCount++
		} else {
			regionalCount = 0
		}
		previous = current
	}
	if text != "" {
		boundaries = append(boundaries, len(text))
	}
	return boundaries, nil
}
