---
type: feat
scope: spec
---

A labelled Operation call may leave out an Optional argument along with its label, which then arrives as Nothing, and `on` and `with` may be Argument Labels, so `loop "bd hh" with {gain: 0.5}` and `loop "c3" on bass with {gain: 0.5}` call the same Operation (ADR 0160).
