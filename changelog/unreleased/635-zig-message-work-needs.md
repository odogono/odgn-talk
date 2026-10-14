---
type: feat
---
The Zig Core's Message Layer sends `effect`, automatic `op` and `release` needs during `reload` and `replace-library` too, as they end the old code's Runs, before their reply (#635).
