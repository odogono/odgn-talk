---
type: feat
scope: cli
---

The live debugger has Fix and Continue (ADR 0068): `:reload` while paused in a Run that hasn't passed a Suspension Point lists the effects that will happen again, then rewinds the Run, reloads the edited file keeping the mailbox, and pauses where its message runs again. The tooling API adds `LiveDebugger.fixAndContinue` and `repeatedEffects`. A Stop, cancel or Rewind queued at a live pause now records its `pc`, so the Trace replays.
