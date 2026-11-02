---
type: feat
scope: cli
---

`northtalk app.talk` offers `peer`: `--listen` and `--peer NAME=tls://HOST:PORT#KEY` carry Remote Sends between Runners over mutual TLS, each end pinned by its key fingerprint, and `--peer-key` keeps a Runner's key across restarts (ADR 0163, #1975). The TS and Zig Cores now keep a `peer` Grant's `post` and `call` under GrantsAsUsed when the Script can `reach` or `expose`, and `caller` when it can `expose`, so a `send` to a Peer works in a trimmed Grant.
