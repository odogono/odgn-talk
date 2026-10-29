---
type: fix
scope: repo
---
Make the TS and Zig Cores agree on Join ordering. A Join Member's wait now takes its place among equal deadlines when the member starts, even if a Fuel Slice preempts the Join's body. Of the member failures that arrive before a preempted Join reaches its closing `end`, the earliest-started member's is raised. A Join's Timeout Block now wins a deadline tie with its own members on the Zig Core too (#1752, #1753).
