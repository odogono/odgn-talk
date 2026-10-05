---
type: feat
---
Check registered Host Object property declarations at Load and Reload in both Cores (and Extend in TS), rejecting literal writes to read-only or missing properties. Dynamic Object non-id keys in Guards now skip the clause with a charged `wrong kind` error without calling the Host; quoted keys that spell Built-in properties retain key semantics in Go, while map keys and Core-held Object ids remain readable (#305).
