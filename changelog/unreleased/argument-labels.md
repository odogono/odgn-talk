---
type: feat
scope: spec
---
Let Handlers name their parameters with Argument Labels, as in `on move piece to square` and `move knight to "e4"`. The labels join the message name into a Selector (`move:to:`), and `send to board: move knight to "e4"` sends a labelled message (ADR 0055).
