---
type: feat
breaking: true
---
Add synchronous Grant release hooks to both Cores for Stop, Reload, revocation and disablement. Carry release acknowledgements, Reload and Library replacement through the Go Message Layer (#618).

Go Capability definitions now accept Operation declarations and options as `CapabilityOption` values; callers expanding `[]Operation` must convert it to `[]CapabilityOption`.
