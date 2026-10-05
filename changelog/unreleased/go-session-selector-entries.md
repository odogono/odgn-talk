---
type: fix
---
The Go Session Host recognises an Entry such as `move 3 to 4` as a call to a labelled Handler, `on move x to y`, by its Selector's first word, as the TS Session Host does (#351).
