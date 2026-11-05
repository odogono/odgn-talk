---
type: feat
scope: ts
---
Let a browser Script reach a server's exposures and hand it Peers to push to: `webSocketLink` and `acceptWebSocket` in `@northtalk/ts/peer` carry Remote Sends over a WebSocket on which each end proves its key, and the TS Runner's `--listen ws://HOST:PORT` accepts them. The chat example in `examples/peer-chat` shows both ends (#2038).
