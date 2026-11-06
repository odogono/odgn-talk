---
type: feat
scope: spec
---

A Trace explains why no Handler Clause matched: the `run` record of a Run that ended `unhandled`, or that the Fallback Handler took, carries `mismatches`, with each named clause's reason (`arity`, `pattern`, `shape` or `guard`) and, for a Clause Shape, what `explain` gives. It's built only while tracing and charges nothing (ADR 0172, #2148).
