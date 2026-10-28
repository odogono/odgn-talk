---
type: feat
scope: repo
---

Compute the State Fingerprint in the Zig Core, so a Host can tell whether two saves hold the same state though each takes a new save id: `talk_group_state_fingerprint` and `talk_core_state_fingerprint` in `talk.h`, the `state-fingerprint` and `save-state-fingerprint` messages, and `group.stateFingerprint()` and `core.stateFingerprint(save)` in `@northtalk/ts/wasm` (#1698).
