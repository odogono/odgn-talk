package text

import "regexp"

var digits = regexp.MustCompile(`[0-9]+`)

func Patterns(n int64) any {
	total := 0
	for i := int64(0); i < n; i++ {
		total += len(digits.FindAllString("a12 b345 c6", -1))
	}
	return total
}
