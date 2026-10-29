---
type: feat
scope: cli
---

Add `northtalk diff-save`, which shows where two saves differ by path, such as `script "a" / variable count (#0): number 0 → number 1`, and `northtalk dump-save`, which prints a save as a tree. Both read a save from either Core, and `diffSaves` in `@northtalk/tooling/save-diff` does the same for tests (#1713).
