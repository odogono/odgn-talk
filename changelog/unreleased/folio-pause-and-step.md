---
type: feat
scope: tools
---

Pause and step a Play Session in Folio. The header's Present button is now Play, with Pause (⌘.) and Step (⌘') beside it, in Browse and Present. While paused, no time passes, so `frame` and pending waits stop and reader input is ignored. A Step moves Play on by one 60 Hz frame. A wait keeps its remaining time across a pause, and the Performance window leaves out paused time (#1209).
