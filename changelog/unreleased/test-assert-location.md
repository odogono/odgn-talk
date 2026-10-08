---
type: feat
scope: cli
---
`northtalk test` reports a failed `assert` or `assertEqual`, and an error raised in stdlib code, at the Test Script's own call rather than at its Test Handler. The TS Core's `compileLibrary` takes an `{ atCaller: true }` option for this (#347).
