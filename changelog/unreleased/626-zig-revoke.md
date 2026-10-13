---
type: feat
---
Revoke a Script's Grant in the Zig Core with `talk_script_revoke`, raising `capability revoked` for later calls, and call a Capability's Grant release hook, set with `talk_with_release_hook` or `store`'s `release`, on revocation and disabling (#626).
