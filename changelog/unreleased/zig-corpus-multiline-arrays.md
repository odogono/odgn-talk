---
type: fix
scope: repo
---
The Zig corpus runner reads arrays and inline tables in `case.toml` that span several lines, as the TS runner does, and its `unexpected <table>.<key>` error names the real table and key instead of garbled text (#2100).
