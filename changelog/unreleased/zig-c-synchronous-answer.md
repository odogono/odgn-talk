---
type: fix
scope: repo
---

The Zig Core's C API resumes a Run whose suspending call the Host answers during its Start, whether with `talk_call_answer` or by returning `TALK_CALL_ANSWERED` with a result. The first answer used to wait for a Pump the Host might never make, and the second was dropped. `talk_pump` now runs a further Pump at the same Clock reading to settle such an answer.
