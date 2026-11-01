---
type: feat
scope: spec
---

An Exposed Script can ask `caller` for the Caller Identity its Host vouches for, so a server knows who made a Remote Send (ADR 0154). Peers can now travel inside Remote Sends, and holding one is permission to send to it. `expose` gives a Peer, and without a name makes an unnamed exposure that only that Peer reaches, which a Script can hand out as a reply-to or push channel (ADR 0155). The Cores and Hosts implement both in later releases.
