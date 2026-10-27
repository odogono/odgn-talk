---
type: fix
scope: ts
---
`openSqliteDatabase('')` and `openSqliteDatabase(':memory:')` now say to open a file in a temporary directory instead, and the README explains why an in-memory database isn't supported.
