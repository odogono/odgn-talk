---
type: perf
scope: ts
---
Run Map writes to a key the Map already has, and calls to a Script's own Handler, on the TS Core's fast path, and keep that path compiled on Bun when a Script first reaches one of its cases late: on Bun, `macro/game-tick` runs about 12% faster, `collections/map-update` about 10% and `macro/transform` about 21%; Node is unchanged (#1939).
