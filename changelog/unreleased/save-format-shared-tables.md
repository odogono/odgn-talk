---
type: perf
scope: spec
---
Shrink the shared save format before its first release: Grants share their declarations, concurrent Runs share the Script Variables they start from, names and other repeated texts are written once in a new `texts` section, and Operation modes and Mark outcomes are single bytes. A Function Value with code no longer repeats its home Script. Saves are now smaller than the old TS JSON saves, and restore is faster (#1758).
