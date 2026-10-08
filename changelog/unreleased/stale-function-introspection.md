---
type: fix
---
Keep stale Function Values' original names and arities through save and restore
in both Cores, so `functionName`, `functionArity` and `:describe` still answer
after their code is discarded (#449). Save formats advance to TS `5` and Go
`go/5`; older saves are no longer readable.
