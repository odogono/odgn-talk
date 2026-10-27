---
type: fix
---
The Zig Core now charges `delete` of a map key by the entries left in the map, as the Cost Model's `set-key` rate says and the TS Core already did; it had charged one Fuel too little for a map of two to sixteen keys and more for larger ones (#1632).
