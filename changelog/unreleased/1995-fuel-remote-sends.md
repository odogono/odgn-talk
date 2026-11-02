---
type: fix
scope: tools
---

Fuel estimates and Fuel Bounds now cover a `send` that may be a Remote Send: when the Host Manifest gives the Script a `peer` Grant, each `send` costs at most the dearer of its own rate and the `capability` rate with that Grant's declared `post` or `call` cost, and a waiting one leaves its reply's conversion open (#1995).
