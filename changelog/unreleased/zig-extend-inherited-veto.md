---
type: fix
scope: repo
---
Reject Extend calls into inherited Handlers containing `veto` on the Zig Core, including through the experimental Go backend, with diagnostics at each veto's defining position (#1060).
