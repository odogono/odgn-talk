---
type: fix
scope: zig
---

The native Zig Runner now withdraws a Script's Peer Exposures when the Script is stopped or its `peer` Grant is revoked or disabled, and keeps them across a Reload. Before, it never withdrew them, so a stopped Script stayed reachable. `talk_peer_impl` gains an optional `release` hook, called as `talk_store_impl`'s is, and the Runner's exposures now pass the peer kit under `zig build test` (#2268).
