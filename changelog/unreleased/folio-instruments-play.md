---
type: feat
scope: tools
---

Folio Scripts can play a Project's Instruments by name during Play: `tell bass to play "c3"` starts a note, and `set the cutoff of bass to 800` changes a parameter. The Instruments play through one AudioWorklet, and the editor completes and checks their Operations and properties (#1894).
