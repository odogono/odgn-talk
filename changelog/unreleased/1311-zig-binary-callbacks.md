---
type: perf
scope: repo
---
Exchange the Zig guest's Host callback needs and results (op, prop, effect and release) in the binary fields envelope when a Host negotiates `callbacks-fields-v1`. The Go adapter negotiates it by default, roughly halving `Run/host/immediate` on Apple Silicon; `TALK_ZIG_CALLBACKS=` keeps JSON.
