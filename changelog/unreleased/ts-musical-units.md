---
type: feat
scope: ts
---
Let a TS Group take a musical clock, made by `musicalClockCapability` and passed as the `musicalClock` option, so a Script's `wait 8 bars` or `wait 2 beats` ends when the Host's Transport reaches that line. Without one, such a `wait` raises `no musical time`. A Musical Unit inside a Compound Unit, such as `1 bar / 1 min`, now raises `incompatible units`, and `exportManifest` writes `musicalTime: true` for a Host that keeps musical time (ADR 0166, #2064).
