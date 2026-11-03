---
status: accepted
---

# The native Runner speaks a minimal TLS 1.3 of its own

[ADR 0163](0163-the-script-runner-carries-remote-sends-over-mutual-tls-with-pinned-keys.md) has every Runner carry Remote Sends over mutual TLS with pinned ECDSA P-256 keys. Zig 0.17's standard library has a TLS client but no server and no client certificates, so the native Runner offered only loopback `tcp://`. It gets a TLS 1.3 of its own in `impl/zig/src/runner/tls/` (#2012), built on the standard library's AEAD, HKDF, X25519 and ECDSA, and scoped to talking to the TS, Go and native Runners rather than to the wider web.

- **One profile:** TLS 1.3 only, `TLS_AES_128_GCM_SHA256`, X25519 key exchange and `ecdsa_secp256r1_sha256` signatures. No HelloRetryRequest, resumption or 0-RTT. The client offers only what the server accepts, and a peer that won't match fails the handshake.
- **Pinning, not certificates:** a handshake checks the SHA-256 of the peer certificate's SubjectPublicKeyInfo against the pin and the CertificateVerify signature with that key. It ignores the certificate's self-signature and dates, since the certificate only carries the key. The listener accepts any key and names the caller by its fingerprint.
- **Keys:** `--peer-key` reads the PEM file the other Runners read: a PKCS #8 or SEC1 P-256 key and a certificate. Without it the Runner generates a key and a self-signed certificate. The loopback `tcp://` form stays, and its `hello` claims this same key.
- **Confidence:** RFC 8448's transcripts as unit vectors, `verifyRunnerPeers` against the TS and Go Runners, negative cases (wrong pin, bad CertificateVerify, truncated records) and a fuzz target on the record and handshake parsers.

## Considered Options

- **Wait for Zig's standard library:** no code to own, but no date, and the native Runner is the one most people meet first.
- **Link BoringSSL or OpenSSL:** proven, but it adds the first C dependency to a build that cross-compiles with `-Dtarget` alone.

## Consequences

- We own security code. Pinning removes certificate path validation, the riskiest part, and the narrow profile keeps the rest small.
- When Zig's standard library gains a TLS server with client certificates, we revisit this and may delete ours.
