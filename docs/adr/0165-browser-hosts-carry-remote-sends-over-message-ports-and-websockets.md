---
status: accepted
---

# Browser Hosts carry Remote Sends over MessagePorts and WebSockets

[ADR 0153](0153-a-send-to-a-peer-is-a-remote-send-answered-like-an-operation.md) leaves the transport to each Host, and [ADR 0163](0163-the-script-runner-carries-remote-sends-over-mutual-tls-with-pinned-keys.md) gives the Script Runner mutual TLS with pinned keys. A browser can't use that: it has no `node:tls`, no usable client certificate, and its TLS checks a server against certificate authorities rather than a pinned key. Yet the two cases [ADR 0155](0155-a-peer-may-travel-inside-a-remote-send-and-holding-it-is-authority.md) was written for are browser cases: a page's Group talking to a Group in a Web Worker, and a browser Script reaching a server and handing it a Peer to push to. So the TS Host gets a peer router that doesn't depend on its runtime, with links over a `MessagePort` and over a WebSocket. The Runner's TLS and TCP become one more link.

```ts
import { PeerRouter, messagePortLink, webSocketLink } from '@northtalk/ts/peer';

const peers = await PeerRouter.create(group);
peers.connect(messagePortLink(worker, { name: 'audio' }));
peers.connect(
  webSocketLink(new WebSocket('wss://chat.example/peer'), { token }),
);
```

- **One router, many links:** the router holds exposures, Peer ids, Caller Identities and the `reach`, `post` and `call` frames of chapter 12, and gives the `peer` implementation. A **link** moves whole frames to one other Host and says who that Host is. It is the only part that knows about sockets, ports or TLS. The router and the browser links ship in `@northtalk/ts` as `@northtalk/ts/peer`, using only web-standard APIs (`crypto.subtle`, `crypto.getRandomValues`, `TextEncoder`), so they run in a browser, a worker, Bun and Node. The Runner's TLS and TCP link stays in the CLI.
- **Same frames:** a link carries the JSON frames chapter 12 gives, in the Value Encoding. A WebSocket sends one text message per frame and a `MessagePort` posts each frame's JSON text, so neither needs the 4-byte length. Each frame is at most 16 MiB, as over TLS.
- **Every Host has a key:** a browser Host makes an ECDSA P-256 key with WebCrypto and fingerprints its SubjectPublicKeyInfo as a Runner does. Peer ids stay `<fingerprint>/<secret>`, so a Peer a browser hands to a server, and one a server hands on to another Runner, means the same thing everywhere. The key lives as long as the Host. A Host that saves its Groups across page loads may keep a non-extractable key in IndexedDB, and otherwise its unnamed exposures' Peers are `unreachable` after a reload.
- **WebSocket proves both keys:** each end's first frame is `{"hello": "<fingerprint>", "key": "<base64 SPKI>", "nonce": "<32 hex digits>"}`. Its second is `{"proof": "<base64 signature>"}`, its key's ECDSA P-256 SHA-256 signature over `northtalk peer ws`, the other end's nonce and its own fingerprint. An end that receives a key not matching its fingerprint, or a proof that doesn't verify, closes the socket. The browser trusts the server's origin through `wss://` and the browser's own certificate checks, and an address may also pin the server's key as `wss://HOST/PATH#FINGERPRINT`. The browser's `hello` may carry `"token"`.
- **The server's Caller Identity** is `{key: "<fingerprint>", via: "ws"}`, merged with what the server Host's `authenticate` returns for the token, such as `{principal: "alice"}`. `authenticate` may refuse, which closes the socket before any Remote Send. The browser's Caller Identity for what the server sends is `{key, via: "ws", origin}`.
- **MessagePort claims its key:** a `MessagePort` can be used only by whoever holds it, so its `hello` is the claim `{"hello": "<fingerprint>"}` with no proof, as on loopback `tcp://`. The Caller Identity is `{key, via: "port"}`, with `name` when the code that made the channel gives one. One `MessageChannel` per pair of Hosts links the page to a worker, or two workers to each other.
- **The TS Runner listens for browsers:** `--listen ws://HOST:PORT` accepts WebSocket links. TLS is a proxy's job, as for `http` ([ADR 0124](0124-http-is-an-optional-standard-capability-answered-by-the-receiving-run.md)). The Runner has no `authenticate`, so its Caller Identity is the key alone. This flag is the TS Runner's: the Go and native Runners need not offer it, and Runners still reach each other over `tls://` and `tcp://`.
- **No forwarding:** a Host sends to a Peer only over a link to the Host whose key the Peer names. A server that hands Alice's `inbox` to Bob's browser gives Bob a Peer he can't use: his sends fail `unreachable`, since his browser has no link to Alice's. A server that wants Bob to reach Alice exposes a Script that relays, and the Caller Identity stays per hop.

## Considered Options

- **Origins instead of keys for browsers and servers:** `wss://chat.example` already names an authenticated server, but a browser has no origin to be reached at, Peer ids would take two forms, and a server's Peers would mean different things to a browser and to a Runner. A key per Host keeps ADR 0155's rule unchanged.
- **A cookie instead of a token in `hello`:** a cookie needs no frame, but it is sent only to the page's own site, needs CSRF care on the upgrade, and isn't available to a worker's own WebSocket in every browser. A token works across origins and from workers.
- **Structured clone over `MessagePort`:** posting objects avoids JSON, but Values are class instances that don't clone, and one codec for every link keeps the frames and their limits the same.
- **Forwarding through the server:** Bob could reach Alice through the server, but the server would need to vouch for a Caller Identity it didn't authenticate, and every handoff would keep a route alive on a Host that isn't a party to it.
- **`ws://` in every Runner:** a browser could reach the Go or native Runner, but the Zig Runner would need a WebSocket server on top of its own TLS. We add it there when someone needs it.

## Consequences

- `RunnerPeers` splits into the router and a TLS and TCP link. The CLI's behaviour and chapter 12's wire don't change.
- `@northtalk/ts` gains the `./peer` entry and its API. Embedders on Bun or Node adapt their own WebSocket server's socket to a link.
- The browser proof doesn't bind to the TLS session, since browsers expose no channel binding, so a party that can break `wss://` can relay one. A pinned server key narrows that for the browser's side, and an untrusted network still needs `wss://`.
