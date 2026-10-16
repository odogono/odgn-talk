---
type: feat
scope: repo
---
Convert every Value Encoding kind in the Elixir Host, as `NorthTalk.Bytes`, `Quantity`, `Range`, `Instant`, `CivilDate`, `Pattern` and `Object` structs, and refuse non-canonical forms. Function Values a Script returns are `NorthTalk.Function` handles bound to their Group, called with `NorthTalk.call/4` and released with `NorthTalk.release/1` or when their Group or owner closes (#993).
