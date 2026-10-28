---
type: fix
scope: ts
---

List a `try`'s Unwind Table entries after those of a `try` inside its catch handler or its `finally` block, as chapter 8 orders them and the Zig Core does. This changes TS disassembly only (#1738).
