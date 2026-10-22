---
type: feat
scope: cli
---

Run a Script file with `northtalk app.talk [args…]` under Bun or Node: it grants the Standard Capabilities as used, Delivers `start args`, serves `http` with `--port` or `PORT`, exits when nothing can happen again and stops gracefully on SIGINT or SIGTERM. `examples/http/hello.talk` is a small web server (ADR 0126).
