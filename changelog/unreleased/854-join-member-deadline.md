---
type: fix
---
The Go and TS Cores count a Join Member's `maxPending` or `MaxWait` from the Pump that started its call, as chapter 6 says, rather than from the Pump where a preempted Join suspends at its `end`. The deadline is saved with the member (#854).
