package northtalk

import coreunicode "github.com/odogono/odgn-talk/impl/go/internal/unicode"

// normalizeHostText is the Host's text-construction seam. Text will use this
// before keeping a Value, mapping invalid UTF-8 to the HostError invalid value.
// Normalization at this boundary charges no Script Fuel or allocation.
func normalizeHostText(text string) (string, error) { return coreunicode.NFC(text) }
