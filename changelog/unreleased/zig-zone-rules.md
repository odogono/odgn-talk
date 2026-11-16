---
type: feat
scope: zig
---

The Zig Core's `toCivil` and `toInstant` convert in a named time zone given Zone Rules, and a `toCivil` or `toInstant` offset that isn't a Quantity now raises `out of domain`, as the Spec says, rather than `wrong kind`.
