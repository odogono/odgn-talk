---
type: fix
---
Refuse limits above the supported conformance profile in the Zig Core before loading a Script, preventing excessive recursion limits from exhausting memory and leaving its Group unable to take more work (#807).
