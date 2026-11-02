---
type: feat
scope: ts
---

Export `operationDeclarations`, which builds the `declarations` `compileLibrary` needs from CapabilityDefs, so a Host can compile a Library that calls a Capability without rebuilding them by hand (#1936).
