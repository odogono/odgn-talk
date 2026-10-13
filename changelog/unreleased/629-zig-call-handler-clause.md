---
type: fix
---
Charge a Command Call's `clause` rate with the clause body's first instruction in the Zig Core, as dispatch does, so a first instruction that faults on its own limit, such as a call past the call depth, charges neither. A Handler that recurses to the call depth now uses the other Cores' Fuel (#629).
