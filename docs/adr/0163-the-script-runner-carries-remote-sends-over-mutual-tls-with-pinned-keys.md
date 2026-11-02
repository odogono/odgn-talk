---
status: accepted
---

# The Script Runner carries Remote Sends over mutual TLS with pinned keys

[ADR 0153](0153-a-send-to-a-peer-is-a-remote-send-answered-like-an-operation.md) leaves the transport to each Host, and [ADR 0155](0155-a-peer-may-travel-inside-a-remote-send-and-holding-it-is-authority.md) requires that a Peer crossing between Hosts names its exposure with an unguessable secret and identifies the target Host's key. The Script Runner is the Host most people meet first, so it needs a transport of its own: two `northtalk app.talk` processes, on one machine or two, should reach each other's exposures with nothing but command-line flags.

```sh
northtalk --listen 127.0.0.1:7400 billing.talk
# peer: listening on tls://127.0.0.1:7400#3f9c…e1
northtalk --peer billing=tls://127.0.0.1:7400#3f9c…e1 shop.talk
```

- **A key per Runner:** each Runner has one ECDSA P-256 key, generated at start or read with `--peer-key`. Its **key fingerprint**, the lowercase hexadecimal SHA-256 of the key's DER SubjectPublicKeyInfo, is the Host key ADR 0155 asks for. There are no certificate authorities: a certificate only carries the key.
- **Mutual TLS, pinned:** a Runner listens with `--listen`, and every connection authenticates both ends. The dialling Runner checks the listener's key against the fingerprint in the address; the listener accepts any key and knows the dialler by its fingerprint. The Caller Identity of a Remote Send that arrives is `{key: "<fingerprint>"}`, with `name` added when a `--peer` names that key.
- **Names come from flags:** `--peer NAME=tls://HOST:PORT#FINGERPRINT` lets `reach NAME` ask that Host for its exposure named `NAME`. A Script may `expose` any name, and every connected Runner may `reach` it.
- **Peers name their Host:** a Peer's id is `<fingerprint>/<secret>`, with 128 random bits of secret, and it crosses as the Value Encoding's `{"$object": ["peer", "<fingerprint>/<secret>"]}`. A Runner sends to a Peer of another Host only if a `--peer` gives that Host's address; to any other it fails `unreachable`.
- **Frames:** each message is a 4-byte big-endian length and a UTF-8 JSON object: `reach` and `reached`, `post`, and `call` and `replied`, with arguments and replies in the Value Encoding.
- **Plain TCP on loopback, too:** `--listen tcp://127.0.0.1:PORT` and `--peer NAME=tcp://127.0.0.1:PORT` carry the same frames without TLS, for debugging and for Runners that don't have TLS yet. Nothing checks either end, so the Runner refuses any host but `127.0.0.1`, `::1` and `localhost`. Each end starts with a `hello` frame claiming its key, so Peer ids still name their Host, and what arrives has no Caller Identity. This is a local convenience that ADR 0155's key rule doesn't cover.
- **Same in every Runner:** chapter 12 fixes the flags and the wire, so the TS, Go and native Zig Runners can talk to each other. The TS Runner implemented it first and the Go Runner next (#1996). Zig's standard library has no TLS server, so the native Runner offers only the loopback `tcp://` form (#1997), claiming a random key in its `hello`.

## Considered Options

- **Plain TCP as the only transport:** simplest, with the exposure secrets as the only protection. It carries no Host key, so nothing can pin a destination or vouch for a caller, and it can't leave one machine safely. It is kept only as the loopback option above.
- **A WebSocket on the Runner's `http` server:** it reuses one listener and suits browsers, but ties `peer` to `http`'s port override and needs a token scheme for identity. A browser Host can still choose it; it isn't the Runner's.
- **Ed25519 keys:** smaller and simpler, but not every TLS stack negotiates them in certificates: the CI image's Bun refused the handshake. ECDSA P-256 is the one curve every TLS 1.3 stack supports.
- **Certificate authorities:** familiar, but a CA is configuration a local program shouldn't need, and pinning the key is what ADR 0155 asks.

## Consequences

- The Runner keeps running while it listens, as it does with Serve Registrations.
- A restarted Runner without `--peer-key` has a new key, so addresses pinned to the old one stop working, and Peers it handed out become `unreachable`.
- Delivery stays at most once: a connection lost before a reply fails the `call` with `unreachable`, and nothing is sent again.
