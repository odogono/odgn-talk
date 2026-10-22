---
type: fix
scope: repo
---

In the Go HTTP Host, `unserve` of a listener's last registration closes its socket before returning, so a later connection is refused rather than reset.
