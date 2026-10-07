---
type: feat
scope: tools
---
Add `bun run corpus:bless`, which keeps a case's new expectations only when the TS and Go Cores agree in both replays. Both Cores' corpus runners now run the complete Corpus by default in CI and end each failure with a command that reproduces it.
