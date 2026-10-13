---
type: fix
---
Fingerprint the Standard Capabilities' Operation Declarations in the Zig Core as the Go and TS Cores do. The codes the Core raises itself, such as `store`'s `invalid key` and `invalid watch`, are left out, and `store`'s error codes declare no fields, so a Group with a `store` Grant saves and restores with the same Group Fingerprint on every Core (#629).
