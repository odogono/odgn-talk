---
type: perf
scope: repo
---

Run counting loops on the Zig Core about 20% faster, and number arithmetic 5–10% faster, by checking each instruction's Fuel and preemption against limits read once (#1906).
