---
type: fix
scope: repo
---
Route cancelled Session inspections through the Go Zig adapter so cancellation before expression execution never starts a property reader or calls a Host getter (#1088).
