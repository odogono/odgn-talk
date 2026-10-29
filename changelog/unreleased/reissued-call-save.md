---
type: feat
scope: spec
---
A save taken after a reissue records the reissued call: its `now` is the Clock reading of the Pump that reissued it, and its `charged` is the Fuel its reissued `Start` charged (#1781).
