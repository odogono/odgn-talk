package messagelayer

import (
	"encoding/json"
	"strconv"
	"testing"
)

// parseInteger only tries text for a string or null, so these keep their
// results and messages.
func TestParseInteger(t *testing.T) {
	for raw, want := range map[string]string{
		`42`:                    "42",
		` 42 `:                  "42",
		`"42"`:                  "42",
		` "-7"`:                 "-7",
		`null`:                  `field "ref" is not an integer`,
		`"x"`:                   `field "ref" is not an integer`,
		`true`:                  `field "ref" is not an integer`,
		`1.5`:                   `field "ref" is not a safe integer`,
		`9007199254740992`:      `field "ref" is not a safe integer`,
		`"9223372036854775807"`: "9223372036854775807",
	} {
		n, err := parseInteger("ref", json.RawMessage(raw))
		got := ""
		if err != nil {
			got = err.Error()
		} else {
			got = strconv.FormatInt(n, 10)
		}
		if got != want {
			t.Errorf("%s: got %s, want %s", raw, got, want)
		}
	}
}
