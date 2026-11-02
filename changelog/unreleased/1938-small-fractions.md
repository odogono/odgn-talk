---
type: perf
scope: ts
---

Compute fractional Numbers with small coefficients without BigInt on the TS Core: add, subtract and compare at equal exponents, multiply, and exact division. `numbers/add` runs about 45% faster, `numbers/multiply` about 55–60% and `numbers/divide` 25–40% (#1938).
