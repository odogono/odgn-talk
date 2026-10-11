---
type: feat
---
Add the Grant release hook to both Cores: a Capability can learn synchronously when one Script's named Grant stops being effective through Stop, Reload, revocation or disablement. The Go message layer relays it to the Host as a `release` request during `pump`.
