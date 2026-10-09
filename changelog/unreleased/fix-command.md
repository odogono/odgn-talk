---
type: feat
---

Sessions have Fix and Continue as the Session Command `:fix <run> <path>` (ADR 0072), in both REPLs: it rewinds a Run still in its first Segment, reloads with the file's declarations in place keeping the mailbox, and runs its message again on the new code. A Transcript records the declarations as `|` lines. In the Playground, Apply becomes **Fix & Continue** while paused in a Run that can be rewound; it lists the effects that will happen again and asks to confirm, and the Session Transcript stops before the paused Entry.
