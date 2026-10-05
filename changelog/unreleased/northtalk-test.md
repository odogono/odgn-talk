---
type: feat
scope: cli
---
Add `northtalk test`, which runs the tests authors write for their own Scripts. Each `on testXxx` Handler in a `*.test.talk` Test Script runs against the Scripts beside it in a fresh Group, with Host Manifest Grants mocked through the `harness` Capability, a virtual Clock and `assert`/`assertEqual` from the `test` Library. `*.transcript` files replay as tests too (ADR 0056).
