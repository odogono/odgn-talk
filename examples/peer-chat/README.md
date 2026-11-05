# Chat between browsers and a Runner

The chat of [ADR 0155](../../docs/adr/0155-a-peer-may-travel-inside-a-remote-send-and-holding-it-is-authority.md), carried over WebSockets ([ADR 0165](../../docs/adr/0165-browser-hosts-carry-remote-sends-over-message-ports-and-websockets.md)). Each browser tab is a Host with its own key. It reaches the server's `chat` exposure and hands it a Peer for an unnamed exposure of its own, which the server pushes each line to.

```sh
northtalk --listen ws://127.0.0.1:7401 examples/peer-chat/chat.talk
bun examples/peer-chat/serve.ts
```

Then open <http://127.0.0.1:7400/?nick=alice> and <http://127.0.0.1:7400/?nick=bob>. `?ws=` points the page at another server. Put a proxy in front for `wss://`, since the Runner doesn't speak TLS itself.

- [chat.talk](chat.talk): the server's Script.
- [page.talk](page.talk): the browser's Script.
- [browser-host.ts](browser-host.ts): the browser's Host, a Group with a `peer` Grant over `webSocketLink`.
- [browser-check.ts](browser-check.ts): runs two Chromium tabs against the Runner, as CI does.
