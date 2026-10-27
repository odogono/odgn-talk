---
type: feat
scope: tools
---
Folio Projects can hold Test Scripts, named like `game.test`, which save with the Project but never run in Play. Each Test Handler runs against a fresh, seeded Play Session, and the Folio Harness lets it press keys, click Elements, move the Clock with `frame` or `advance`, change Page and read Element properties. Both Tetris Example Projects ship one (#1614).
