---
type: feat
scope: spec
breaking: true
---
The binary Request/Pump map layout, `request-pump-map-v1`, is retired. The Spec defines only the JSON and fields layouts. The Zig guest refuses the feature in `hello` like any unknown feature, and the experimental Go adapter no longer accepts `TALK_ZIG_REQUEST_PUMP=map` (#1334).
