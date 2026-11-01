---
type: feat
scope: repo
---
Let Scripts make HTTP requests with `http`'s `fetch` on the Zig Core and the native Zig Script Runner. `talk_http_impl` gains `fetch`, and a NULL function leaves its Operations out, so a Host offers the server Operations, `fetch`, or both; the Message Layer accepts the same subsets. The native Runner fetches from any origin with an HTTPS client that verifies certificates and host names (#1869).
