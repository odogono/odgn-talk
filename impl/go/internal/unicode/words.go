package unicode

import "unicode/utf8"

// Span is a half-open interval of UTF-8 byte offsets.
type Span struct{ Start, End int }

// Words returns maximal runs of Characters whose first scalar is not
// White_Space (chapter 4). Punctuation stays in its word.
func Words(text string) ([]Span, error) {
	boundaries, err := Boundaries(text)
	if err != nil {
		return nil, err
	}
	var words []Span
	start := -1
	for i := 0; i+1 < len(boundaries); i++ {
		cp, _ := utf8.DecodeRuneInString(text[boundaries[i]:])
		if WhiteSpace(cp) {
			if start >= 0 {
				words = append(words, Span{start, boundaries[i]})
				start = -1
			}
		} else if start < 0 {
			start = boundaries[i]
		}
	}
	if start >= 0 {
		words = append(words, Span{start, len(text)})
	}
	return words, nil
}

// WordBreaks returns the start and end of each word. Whitespace-only text
// has no word breaks; an end of text matches only beside a non-space Character.
func WordBreaks(text string) ([]int, error) {
	words, err := Words(text)
	if err != nil {
		return nil, err
	}
	var breaks []int
	for _, word := range words {
		breaks = append(breaks, word.Start, word.End)
	}
	return breaks, nil
}
