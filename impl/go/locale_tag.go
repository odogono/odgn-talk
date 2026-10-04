package northtalk

import "regexp"

// RFC 5646 §2.1's ASCII ABNF, not registry validity (§2.2.9). In particular,
// duplicate variants and extension singletons remain syntactically well-formed.
var localeLanguageTag = regexp.MustCompile(`(?i)^(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*(?:-x(?:-[a-z0-9]{1,8})+)?$`)
var localePrivateTag = regexp.MustCompile(`(?i)^x(?:-[a-z0-9]{1,8})+$`)
var localeIrregularTag = regexp.MustCompile(`(?i)^(?:en-gb-oed|i-(?:ami|bnn|default|enochian|hak|klingon|lux|mingo|navajo|pwn|tao|tay|tsu)|sgn-(?:be-fr|be-nl|ch-de))$`)

func wellFormedLocale(tag string) bool {
	// Case-insensitive regexp folding includes non-ASCII letters; exclude those
	// before matching, without trimming or changing the Host's spelling.
	for i := range len(tag) {
		b := tag[i]
		if !(b >= 'A' && b <= 'Z' || b >= 'a' && b <= 'z' || b >= '0' && b <= '9' || b == '-') {
			return false
		}
	}
	return localeLanguageTag.MatchString(tag) || localePrivateTag.MatchString(tag) || localeIrregularTag.MatchString(tag)
}
