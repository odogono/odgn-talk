---
type: feat
scope: spec
breaking: true
---
Add English comparison words that spell existing comparisons, in both Cores: `does not contain`, `does not begin with`, `does not end with`, `does not match`, `is greater than`, `is less than`, `is at least`, `is at most` (each also after `is not`), `comes before` and `comes after` (ADR 0075). Each lowers to exactly the instructions of the comparison it spells. `does` and `comes` join the FOLLOW set, so a chunk index named `does` or `comes` needs brackets. A Command Call label `does` followed by an argument starting with `not`, or a label `comes` followed by a Name `before`, now reads as the operator.
