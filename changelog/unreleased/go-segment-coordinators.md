---
type: feat
---
The Go Core's Segment-bound Grants can share a participant through a Segment Coordinator: `DefineCoordinatedCapability` maps each binding to one, and Grants on the same coordinator enroll in one Segment with a single `Begin` and one `Commit` or `Rollback` covering them all (ADR 0069, #460).
