---
type: fix
scope: ts
---
Keep the started members of a Join whose body a Fuel Slice preempted as pending calls across save and restore, so the Host can settle them and unsettled ones fail with `call lost` (#374).
