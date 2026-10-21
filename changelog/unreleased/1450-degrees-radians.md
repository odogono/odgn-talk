---
type: feat
scope: spec
---
Add the `degrees(x)` and `radians(x)` Built-ins, which convert between radians, Talk's one angle unit, and degrees. Each is correctly rounded to 34 digits like the trigonometric functions, so `radians(180)` is `pi` and `degrees(pi)` is `180` (#1450).
