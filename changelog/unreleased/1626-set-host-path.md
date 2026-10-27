---
type: feat
scope: spec
---
`set` writes a path below a Host Object property, so `set the isLocked of the door of me to true` reads `door`, changes one key and writes it back with one Set. A Stop, cancel or rewind never lands between the read and the write (#1626).
