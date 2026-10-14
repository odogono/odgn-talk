---
type: feat
scope: spec
---
Remove the Go and Zig Message Layers' 64-level frame nesting limit. Decode and
encode deep Values with heap work stacks, preserve pending Host exchanges after
malformed deep input, and keep Go replies beyond JSON's 10,000-level
input-validation ceiling intact (ADR 0088, #891).
