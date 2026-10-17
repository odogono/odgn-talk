---
type: feat
scope: spec
---
Add the `random(n)` Built-in, which gives a whole number from 1 to `n` from a PCG32 generator the Script Group holds. The Host seeds it when it makes the Group (`seed`, 0 by default), saves carry its state, and every Core gives the same draws for the same seed (ADR 0096, #1111). Folio seeds Browse and Present from the clock, and `PlaySession` takes a fixed `seed`.
