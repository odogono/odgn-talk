---
type: fix
scope: go
---

The Go Runner now withdraws a Script's Peer Exposures when the Script is stopped or its `peer` Grant is revoked or disabled, and keeps them across a Reload. Before, it never withdrew them, so a stopped Script stayed reachable. `northtalk.org/go/peer` gains `Link`, `Connect`, `Close`, `Options.Dial` and `Options.AddressOf` for carrying Remote Sends to other Hosts, and the Runner's mutual TLS and loopback TCP are now links (#2268).
