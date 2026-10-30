package northtalk

import coreunicode "northtalk.org/go/internal/unicode"

// normalizeHostText is the Host's text-construction seam. Text uses it before
// keeping a Value, mapping invalid UTF-8 to the HostError invalid value.
// Normalization at this boundary charges no Script Fuel or allocation.
func normalizeHostText(text string) (string, error) { return coreunicode.NFC(text) }
