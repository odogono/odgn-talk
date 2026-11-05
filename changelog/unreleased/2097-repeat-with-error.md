---
type: feat
scope: spec
---
Add the syntax error `repeat with`. HyperTalk's counted loop, `repeat with i from 1 to n` or `repeat with i = 1 to n`, is now reported at `with`, and the message says to write `repeat for each i in 1..n`, instead of an `unexpected token` at `i` that pointed at `repeat 3 times` (#2097).
