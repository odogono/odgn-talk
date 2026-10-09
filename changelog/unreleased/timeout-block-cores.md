---
type: feat
---
Implement Timeout Blocks, `with timeout of d … end timeout`, in both Cores: one deadline bounds every wait written inside, nested blocks keep the earliest, and a deadline that runs out abandons what the Run waits on and raises `timeout` with `deadline: true`. The checker reports `not in a timeout` and `empty timeout`, a Session reads the block as an Entry, the formatter, `prefer-explicit-end` and the LSP handle it, and both Cores refuse `deadline` in a Host `Fail`'s Data (#542, ADR 0073).
