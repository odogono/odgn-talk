---
type: feat
scope: repo
---
The Zig Core counts `wait 8 bars` and `wait 2 beats` on the Host's musical clock, the reserved `musical-clock` Grant, and raises `no musical time` without one. A fraction or a negative count raises `out of domain`, `wait 0 bars` doesn't suspend, and `bar` and `beat` stay out of Compound Units, so `1 bar / 1 min` raises `incompatible units`. C Hosts make the clock with `talk_musical_clock_capability`, and the Host Manifest gains `musical_time`, written as `musicalTime: true` (ADR 0166, #2065).
