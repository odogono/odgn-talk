---
type: fix
scope: ts
---
The TS peer router now withdraws a Script's exposures when it stops, its owner Object is disposed, or its `peer` Grant is revoked or disabled, so a stopped Script's names are free again and Remote Sends to it fail as `not exposed` (#2211).
