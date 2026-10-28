---
type: feat
scope: spec
---

Report `unit without number` instead of `unexpected token` when a Unit follows a name or a bracketed expression, as in `wait tick s`. A Unit can only follow a number, so the message suggests `tick as s`, `tick * 1 s` or putting the Unit in the Constant.
