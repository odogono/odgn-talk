---
type: feat
---
Add the Shape check Built-ins `conforms(value, shape)`, `check(value, shape)` and `explain(value, shape)` to all three Cores. A Shape is written as data in the Host Manifest spelling; the whole definition is validated first (`invalid shape` with a reason and Shape-relative path), then the value is tested with Capability Shape acceptance — as a boolean, by raising the first `wrong kind`/`not encodable` mismatch, or as a list of every mismatch with failed union alternatives grouped (#695, ADR 0080).
