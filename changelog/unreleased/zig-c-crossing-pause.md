---
type: feat
scope: zig
---
A C Host can answer a Host Object property or Object Collection callback later: returning `TALK_CALL_STARTED` inside `talk_pump` pauses the Pump at the crossing until `talk_crossing_answer` (#2276).
