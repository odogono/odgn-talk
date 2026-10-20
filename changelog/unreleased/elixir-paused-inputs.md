---
type: feat
scope: repo
---
The Elixir Host requests `paused-inputs-v1`: while an immediate callback or a lifecycle hook runs, inputs for its paused Group, such as a Stop, a Delivery or a settlement, are admitted before its result, so a Stop lands at that crossing. Without the feature, and for a worker call or another Group's work, the callback's own call is refused with `reentrant call` instead of waiting (#1007).
