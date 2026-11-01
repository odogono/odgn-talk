---
type: feat
scope: go
---
Let Scripts make HTTP requests with `http`'s `fetch` in the Go embedding. The embedded Zig Core checks the request, normalizes its URL and checks the Host's answer. `HTTPCapabilityWith` offers the server Operations, `fetch`, or both, and takes an `HTTPFetchImpl`, which hears the normalized URL and the request. `respond` now refuses header names repeated in different cases. The `northtalk` Script Runner fetches from any origin, with a `net/http` client that follows no redirect, decompresses nothing, bounds the response, verifies TLS and aborts abandoned calls (#1869).
