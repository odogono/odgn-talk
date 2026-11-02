---
type: feat
scope: cli
---

The native Zig `northtalk` Runner offers `peer` over plain TCP on loopback, with `--listen tcp://…` and `--peer NAME=tcp://…`, so it carries Remote Sends to and from TS and Go Runners on one machine. It has no TLS yet, so it refuses the `tls://` forms and `--peer-key` (#1997).
