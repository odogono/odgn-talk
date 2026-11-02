---
type: feat
scope: ts
---

Add the optional `peer` Standard Capability to the TS Core: `peerCapability` and the Core-fixed `peerKind`. A `send` to a Peer is a Remote Send through the Script's one `peer` Grant (`post`, or `call` with `and wait`), with `expose`, `unexpose`, `reach` and `caller`, and Peers that travel inside Remote Sends (#1972). The Conformance Corpus gains `peer/` cases and a `caller` key on `deliver` and `request` lines for a Remote Send's Caller Identity (#1971).
