---
type: fix
---
The Zig Core now charges `delete` of a map key by the entries left in the map, as the Cost Model's `set-key` rate says and the TS Core already did. It had charged as if no entries were left, so one Fuel too little for every 16 remaining (#1632).
