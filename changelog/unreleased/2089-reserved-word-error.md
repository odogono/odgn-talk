---
type: feat
scope: spec
---
Add the syntax error `reserved word`. A Reserved Word where a Name belongs, such as `put x into wait` or `on go end`, is now reported at the word, and the message says which word is reserved, instead of a generic `unexpected token` that `put 1 into replace` used to report at the end of the line (#2089).
