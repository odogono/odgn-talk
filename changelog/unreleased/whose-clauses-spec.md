---
type: feat
scope: spec
breaking: true
---
Add Whose Clauses, which keep the chunks whose condition holds: `every item of orders whose the amount of it > 100 GBP` and `the first line of report whose it begins with "WARN"` (ADR 0074). `whose` joins the FOLLOW set, so a chunk index named `whose` needs brackets.
