---
type: feat
scope: spec
---
Charge comparisons for every logical pair they examine, at every depth, counting a shared part at each occurrence as logical size does. A Value built by repeated self-sharing no longer makes equality, ordering, membership or `min`/`max` do exponential work for almost no Fuel: Cores compare each shared pair once but charge for each occurrence, so the work is bounded by the Fuel budget on the TS, Go and Zig Cores (#890).
