---
type: perf
scope: repo
---
Cut the Elixir Host's allocation for binary callback needs and answers by about 60%, so immediate callbacks in the opt-in fields envelope are about 2% slower than JSON rather than 15–18% slower (#1316).
