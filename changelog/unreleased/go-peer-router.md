---
type: feat
scope: go
---

Add `northtalk.org/go/peer`, a Peer Router for the `peer` Capability. It carries Remote Sends between the Groups attached to it, and withdraws a Script's Peer Exposures when its `peer` Grant is stopped, revoked or disabled, or when its Group is detached. Reload keeps them (#2268).
