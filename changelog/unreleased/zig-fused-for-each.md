---
type: perf
scope: repo
---
Turn a `repeat for each` loop over a List or Range in one step with one Fuel charge on the Zig Core's fast path, writing a Range's item into its local in place when nothing else holds it, with Fuel and the Trace unchanged: `numbers/add`, `numbers/multiply` and `numbers/divide` are 20–29% faster and `core/calls` 15% faster (#1931).
