---
type: perf
scope: repo
---

Stop the Zig Core scanning every suspending call a Group has ever made: settled and abandoned calls leave the live list and release their arguments, so a long-lived Group's calls, rollbacks and Message Layer exchanges no longer slow down with age (#1101).
