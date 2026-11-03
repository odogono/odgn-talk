---
type: fix
scope: repo
---

The Zig Core's `http fetch` no longer risks sending a request to a corrupted host. A parsed URL kept its lowercased host as a slice of its own buffer, which dangled once the URL was returned by value (#1907).
