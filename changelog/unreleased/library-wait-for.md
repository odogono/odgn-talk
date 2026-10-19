---
type: feat
scope: repo
---
Library Handlers may use `wait for` and Joins. A Library's `wait for` observes the Script whose Run calls it, so a shared "prompt, then wait for an answer or a timeout" helper can live in a Library. A `from` in Library code may not name a Script (ADR 0113, #1342). The TS Core now tests a Library wait's Guards against the Library's own code.
