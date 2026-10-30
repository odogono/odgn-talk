---
type: fix
scope: go
---

`northtalk.org/go` and `northtalk.org/go/sqlite` now require each other at a published pseudo-version instead of `v0.0.0`, so `go get northtalk.org/go@main` resolves outside this repository.
