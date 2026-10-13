---
type: feat
---
Add object crossings to the Zig Core's Session Host: a Transcript's `%` envelopes replay Object Kinds, objects, property callbacks, Host actions, Function handles and Restore resolver outcomes. `:inspect` of an object prints its property rows and reads them through the normative reader. A Host Object property's well-formed failure now raises its own code, with `capability` and `operation`, instead of `host error`. `sessions/object-inspection` passes (#629).
