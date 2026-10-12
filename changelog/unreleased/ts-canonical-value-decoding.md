---
type: fix
scope: ts
breaking: true
---
Refuse non-canonical Value Encodings in the TS Core (#652). Hosts must encode integers with magnitude below 2⁵³ and no fraction digits as JSON numbers, and maps without a key starting with `$` as JSON objects. This also applies to Store contents, SQLite Store values, Session Object recordings and snapshot Value Encodings; previously accepted redundant `$dec` and `$map` forms now fail.
