---
type: feat
scope: ts
---
Add a `sqlite` implementation on `node:sqlite` for TS Hosts on Node, Deno or Bun, sharing each database's Segment Coordinator with the SQLite Store, which moves from `bun:sqlite` to it (ADR 0070).
