---
type: feat
scope: go
---

Go Hosts can offer the optional `peer` Standard Capability: `Core.PeerCapability` and the Core-fixed `Core.PeerKind`, running on the embedded Zig Core, which now routes a `send` to a Peer through the Script's `peer` Grant (#1973). `talk.h` gains `talk_peer_capability` and `talk_peer_kind`. Both Cores now charge a Remote Send at the `capability` rate, so its declared cost and its result's conversion count, as for any call to the Operation.
