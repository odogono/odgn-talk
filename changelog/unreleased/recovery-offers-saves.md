---
type: feat
scope: spec
---
Validate Recovery Offers dispatch saves in both Cores and preserve their continuation through preemption, cleanup and cancellation (#390). Go uses private save format go/2; prior go/1 saves are no longer readable.
