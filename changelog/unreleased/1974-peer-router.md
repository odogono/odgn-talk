---
type: feat
scope: go
---

Add an in-process peer router Example Host, in TS and Go, with tests that run two Groups through Remote Sends end to end (#1974). Go Hosts can now make a Peer inside a Host function, such as `Reach`'s answer, since `PeerCapability` declares the `peer` Object Kind to each Group's guest before it pumps.
