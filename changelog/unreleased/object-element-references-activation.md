---
type: feat
scope: spec
---
Activate Object Element References: `element s of o`, `the last element of o`
and `the number of elements of o` parse, lower to `get-element` and
`count-elements`, and run on the TS Core against an Object Kind's optional
`elements` collection, recorded as `prop` crossings with `count`, `at` or
`find`. A variable named `element` or `elements` before `-` now starts a
reference: write `(element) - 1` (#1143).
