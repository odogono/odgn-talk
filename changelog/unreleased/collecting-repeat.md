---
type: feat
scope: spec
breaking: true
---
Let a `repeat` collect its results, as in `repeat for each r in rows collecting the name of r into names`. Every pass that finishes adds one value to a new list, so `next repeat` filters (ADR 0059). A variable named `collecting` straight after a chunk word is now bracketed, as in `item (collecting) of xs`.
