---
type: perf
scope: ts
---

Make `core.stateFingerprint(save)` read the State Fingerprint from the save's header instead of hashing every section, as chapter 10 specifies: about 4.3 ms down to 13 µs for an 800 KB save.
