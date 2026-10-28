---
type: feat
scope: cli
---
When the Host Manifest names an Owner Kind, `northtalk test` gives each Script under test a mock owner of that kind as `me`, which the harness's new `owner` Operation returns and `set` seeds (#1645).
