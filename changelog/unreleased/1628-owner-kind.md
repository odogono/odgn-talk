---
type: feat
scope: spec
---
A Host Manifest may name an Owner Kind with `ownerKind`: the Object Kind of `me` for its kind of Script, which tooling reads and the Core never does. `ExportManifest` writes it last and refuses a kind that isn't in `objectKinds` (#1628).
