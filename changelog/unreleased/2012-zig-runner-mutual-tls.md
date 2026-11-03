---
type: feat
scope: cli
---

The native Zig Runner carries Remote Sends over mutual TLS with pinned keys, using a minimal TLS 1.3 of its own: it takes `--listen HOST:PORT`, `tls://` addresses and `--peer-key`, gives a Caller Identity, and talks to the TS and Go Runners (#2012).
