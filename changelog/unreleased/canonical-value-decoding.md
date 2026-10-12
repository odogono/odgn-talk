---
type: feat
scope: spec
breaking: true
---
Decode only the canonical Value Encoding: a number, tag or payload the encoder would not write, such as `{"$dec": "3"}` or an `$instant` with a UTC offset, is refused as `invalid value` (#650).
