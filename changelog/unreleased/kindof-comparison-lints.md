---
type: feat
scope: tools
---
Add the `kindof-comparison` hint, which suggests `x is a number` for `kindOf(x) = "number"` with a quick fix, and the `impossible-kind` warning for `kindOf` compared with text that isn't a kind name, such as `"integer"`, which is never equal. `@northtalk/ts` now exports `kindNames` (#1784).
