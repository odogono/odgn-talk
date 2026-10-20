---
type: feat
scope: ts
---
Give a `send failed` `ScriptError` a typed `reason`, such as `cancelled` or `errored`, so a Host can switch on it without decoding `data` (#1421).
