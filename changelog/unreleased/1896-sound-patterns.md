---
type: feat
scope: tools
---

Play Sound Patterns in Folio: `loop "bd [hh hh] sd hh"` loops Mini-Notation from the next bar, `play` plays one bar of it now, and `stop` ends them, each with `on <Instrument>` and `with {gain, pan, speed}`. A Script loops one pattern per Instrument, and a second `loop` replaces the first on the next bar. `tell sound to loop` of a whole sound becomes `play … with {repeat: true}` when an older Project opens (#1896).
