---
type: feat
scope: ts
---
Add `@northtalk/ts/peer`: a `PeerRouter` that holds a Host's exposures and carries Remote Sends over any link that moves whole frames, using only web-standard APIs so it runs in browsers, workers, Bun and Node. The Script Runner's TLS and loopback TCP now plug into it as one such link (#2036).
