---
type: fix
---
Reject an over-long JSON number in a Message Layer frame in linear time, so a malformed frame can't hold the Go Core or run a capped `wasip1` instance out of memory (#608).
