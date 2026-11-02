---
type: feat
scope: tools
---

Folio plays only a Project's own sounds: the global kits are gone, and Folio no longer downloads any kit WAVs. A pattern naming a sound the Project lacks says so, and **Add Music Sound…** in Info copies any of the Music Base Project's sounds into the Project. `name:n` plays the sound named `name:n`, without wrapping. Without `on`, `play` is timed by the Transport even for a whole sound such as `play "bell"`; only `play` `with {repeat: true}` plays outside it.
