---
type: fix
breaking: true
---
Require canonical Value Encoding in the Go Core, including Message Layer inputs,
Session object actions and Store file members (#651). Hosts must write the
encoder's number forms, tags and payloads; noncanonical inputs now fail as
`invalid value` rather than being normalised. JSON white space, string escapes
and NFC text normalisation remain accepted.
