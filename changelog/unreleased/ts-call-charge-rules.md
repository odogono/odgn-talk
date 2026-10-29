---
type: fix
scope: ts
---

Make `call.charge(fuel)` follow the Metered Operations rules on every call the TS Core makes, as the Zig Core already does. An amount that isn't a whole number of Fuel, such as `-5` or `1.5`, is now `invalid value` instead of being accepted. Once a charge is refused, later charges in the same callback are refused too, instead of a smaller one getting through. A call reissued after restore draws on the Cleanup Budget while its Run is cancelling.
