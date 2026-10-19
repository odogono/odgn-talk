---
type: perf
scope: repo
---
Encode the Elixir Host's binary callback answers directly from the answer map, bringing fields-mode immediate callbacks to within 0.6% of JSON, and type nested Values in the fields envelope by message rather than by key name (#1316).
